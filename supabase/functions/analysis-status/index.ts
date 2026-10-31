import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return json({ error: "Invalid analysis ID." }, 400);
  }
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return json({ error: "The analysis service is not configured." }, 503);
    const admin = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await admin.from("analysis_jobs")
      .select("id,ticker,status,result,error,created_at,updated_at,progress,stage")
      .eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return json({ error: "Analysis request not found." }, 404);
    return json(data);
  } catch (error) {
    console.error("analysis-status error:", error);
    return json({ error: "Could not retrieve analysis status." }, 500);
  }
});
