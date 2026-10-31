import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const { ticker, period = "5y", horizon = 30 } = await req.json();
    const symbol = String(ticker ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9.^=-]{1,20}$/.test(symbol)) return json({ error: "Enter a valid stock ticker." }, 400);
    if (!["1y", "2y", "5y", "10y", "max"].includes(period)) return json({ error: "Invalid history period." }, 400);
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 60) return json({ error: "Forecast horizon must be 1–60 trading days." }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const githubToken = Deno.env.get("STOCK_ANALYSER_GITHUB_TOKEN");
    if (!supabaseUrl || !serviceKey || !githubToken) {
      console.error("Missing server configuration for job dispatch.");
      return json({ error: "The analysis service is not configured yet." }, 503);
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? req.headers.get("x-real-ip") ?? "unknown";
    const ipHash = await sha256(forwarded + (Deno.env.get("RATE_LIMIT_SALT") ?? serviceKey.slice(0, 24)));

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: countError } = await admin.from("analysis_jobs")
      .select("id", { count: "exact", head: true })
      .eq("client_ip_hash", ipHash)
      .gte("created_at", since);
    if (countError) throw countError;
    if ((count ?? 0) >= 5) return json({ error: "Hourly analysis limit reached. Try again later." }, 429);

    const { data: job, error: insertError } = await admin.from("analysis_jobs")
      .insert({ ticker: symbol, period, horizon, status: "queued", client_ip_hash: ipHash })
      .select("id")
      .single();
    if (insertError) throw insertError;

    const owner = Deno.env.get("GITHUB_OWNER") ?? "andygeng2023";
    const repository = Deno.env.get("GITHUB_REPOSITORY") ?? "Stock-Analyser";
    const workflow = Deno.env.get("GITHUB_ANALYSIS_WORKFLOW") ?? "analyze-stock.yml";
    const dispatch = await fetch(
      `https://api.github.com/repos/${owner}/${repository}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { job_id: job.id, ticker: symbol, period, horizon: String(horizon) },
        }),
      },
    );

    if (!dispatch.ok) {
      const detail = (await dispatch.text()).slice(0, 300);
      await admin.from("analysis_jobs").update({
        status: "failed", error: "Could not start the analysis worker.", updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      console.error("GitHub workflow dispatch failed:", dispatch.status, detail);
      return json({ error: "Could not start the analysis worker. Check the GitHub token and workflow setup." }, 502);
    }

    return json({ id: job.id, status: "queued", ticker: symbol }, 202);
  } catch (error) {
    console.error("request-analysis error:", error);
    return json({ error: "Could not create the analysis request." }, 500);
  }
});
