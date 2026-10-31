import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

const MAX_QUEUED_JOBS = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json();
    const mode = body.mode === "scan" ? "scan" : "analysis";
    const symbol = mode === "scan" ? "SCAN" : String(body.ticker ?? "").trim().toUpperCase();
    const period = mode === "scan" ? "2y" : (body.period ?? "5y");
    const horizon = mode === "scan" ? 30 : (body.horizon ?? 30);
    const scanSource = mode === "scan" ? String(body.source ?? "both").toLowerCase() : "both";
    if (mode === "scan" && !["yfinance", "nasdaq", "both"].includes(scanSource)) {
      return json({ error: "Choose Yahoo Finance, Nasdaq, or both as the scan source." }, 400);
    }

    if (mode === "analysis" && !/^[A-Z0-9.^=-]{1,20}$/.test(symbol)) {
      return json({ error: "Enter a valid stock ticker." }, 400);
    }
    if (!["1y", "2y", "5y", "10y", "max"].includes(period)) return json({ error: "Invalid history period." }, 400);
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 60) {
      return json({ error: "Forecast horizon must be 1–60 trading days." }, 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const githubToken = Deno.env.get("STOCK_ANALYSER_GITHUB_TOKEN");
    if (!supabaseUrl || !serviceKey || !githubToken) {
      console.error("Missing server configuration for job dispatch.");
      return json({ error: "The analysis service is not configured yet." }, 503);
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: existing, error: existingError } = await admin.from("analysis_jobs")
      .select("id,status")
      .eq("job_type", mode)
      .eq("scan_source", scanSource)
      .eq("ticker", symbol)
      .eq("period", period)
      .eq("horizon", horizon)
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) return json({ id: existing.id, status: existing.status, ticker: symbol, mode, reused: true }, 202);

    const { count: queuedCount, error: queueCountError } = await admin.from("analysis_jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "queued");
    if (queueCountError) throw queueCountError;
    if ((queuedCount ?? 0) >= MAX_QUEUED_JOBS) {
      return json({ error: "The analysis queue is currently full. Please try again shortly." }, 503);
    }

    const { data: job, error: insertError } = await admin.from("analysis_jobs")
      .insert({
        ticker: symbol,
        period,
        horizon,
        job_type: mode,
        scan_source: scanSource,
        status: "queued",
        client_ip_hash: "public-no-hourly-limit",
      })
      .select("id")
      .single();
    if (insertError) throw insertError;

    const owner = "andygeng2023";
    const repository = "Stock-Analyser";
    const workflow = "analyze-stock.yml";
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
        body: JSON.stringify({ ref: "main" }),
      },
    );

    if (!dispatch.ok) {
      const detail = (await dispatch.text()).slice(0, 300);
      await admin.from("analysis_jobs").update({
        status: "failed",
        error: "Could not start the analysis worker.",
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      console.error("GitHub worker dispatch failed:", dispatch.status, detail);
      return json({ error: "Could not start the analysis worker. Check the GitHub token and workflow setup." }, 502);
    }

    return json({ id: job.id, status: "queued", ticker: symbol, mode }, 202);
  } catch (error) {
    console.error("request-analysis error:", error);
    return json({ error: "Could not create the analysis request." }, 500);
  }
});
