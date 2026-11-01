import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

function normaliseTicker(value: unknown): string {
  const ticker = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9.^=-]{1,20}$/.test(ticker)) throw new Error("Enter a valid ticker.");
  return ticker;
}

function samplePreview(values: unknown, limit: number): number[] {
  if (!Array.isArray(values)) return [];
  const numeric = values.map(Number).filter((value: number) => Number.isFinite(value));
  if (numeric.length <= limit) return numeric;
  if (limit <= 1) return [numeric[numeric.length - 1]];
  return Array.from({ length: limit }, (_, index) =>
    numeric[Math.round(index * (numeric.length - 1) / (limit - 1))]
  );
}

function compactAnalysis(result: any, indexedAt: string | null) {
  if (!result) return null;
  return {
    company: result.company ?? result.ticker,
    currency: result.currency ?? "USD",
    price: result.price ?? null,
    change_percent: result.change_percent ?? null,
    as_of: result.as_of ?? null,
    indexed_at: indexedAt,
    history_preview: samplePreview(result.history?.close, 72),
    forecast_preview: samplePreview(result.forecast?.hybrid, 30),
    market_summary: result.market_summary ?? {},
    fundamentals: {
      market_cap: result.fundamentals?.market_cap ?? null,
      sector: result.fundamentals?.sector ?? null,
      industry: result.fundamentals?.industry ?? null,
      profit_margin: result.fundamentals?.profit_margin ?? null,
      return_on_equity: result.fundamentals?.return_on_equity ?? null,
    },
    model: { metrics: { hybrid: result.model?.metrics?.hybrid ?? {} } },
    forecast: {
      horizon: result.forecast?.horizon ?? 30,
      expected_change_percent: result.forecast?.expected_change_percent ?? null,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (!token || token === authorization) return json({ error: "Sign in to use your watchlist." }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !publishableKey || !serviceKey) {
      return json({ error: "The watchlist service is not configured." }, 503);
    }

    const userClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: "Bearer " + token } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await userClient.auth.getUser(token);
    if (userError || !userData.user) return json({ error: "Your session has expired. Sign in again." }, 401);
    const userId = userData.user.id;

    const body = await req.json();
    const action = String(body.action ?? "");
    if (!["list", "add", "remove"].includes(action)) return json({ error: "Unknown watchlist action." }, 400);

    if (action === "add") {
      const ticker = normaliseTicker(body.ticker);
      const { count, error: countError } = await userClient.from("watchlist_items")
        .select("id", { count: "exact", head: true });
      if (countError) throw countError;
      const { data: existing, error: existingError } = await userClient.from("watchlist_items")
        .select("id").eq("ticker", ticker).maybeSingle();
      if (existingError) throw existingError;
      if (!existing && (count ?? 0) >= 100) {
        return json({ error: "A watchlist can contain up to 100 stocks." }, 409);
      }
      const { error } = await userClient.from("watchlist_items")
        .upsert({ user_id: userId, ticker }, { onConflict: "user_id,ticker", ignoreDuplicates: true });
      if (error) throw error;
      return json({ success: true, ticker });
    }

    if (action === "remove") {
      const ticker = normaliseTicker(body.ticker);
      const { error } = await userClient.from("watchlist_items").delete().eq("ticker", ticker);
      if (error) throw error;
      return json({ success: true, ticker });
    }

    const { data: items, error: listError } = await userClient.from("watchlist_items")
      .select("ticker,created_at").order("created_at", { ascending: false });
    if (listError) throw listError;
    if (!items?.length) return json({ items: [] });

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const tickers = items.map((item) => item.ticker);
    const { data: indexed, error } = await admin.from("market_index")
      .select("ticker,result,indexed_at")
      .in("ticker", tickers)
      .eq("period", "5y").eq("horizon", 30).eq("indexer", "rapidIndex");
    if (error) throw error;
    const byTicker = new Map((indexed ?? []).map((row: any) => [row.ticker, row]));
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const staleTickers = items.filter((item) => {
      const row: any = byTicker.get(item.ticker);
      return !row?.indexed_at || new Date(row.indexed_at).getTime() < sixHoursAgo;
    }).map((item) => item.ticker);
    if (staleTickers.length) {
      const githubToken = Deno.env.get("STOCK_ANALYSER_GITHUB_TOKEN");
      if (githubToken) {
        try {
          const dispatch = await fetch("https://api.github.com/repos/andygeng2023/Stock-Analyser/actions/workflows/watch-index.yml/dispatches", {
            method: "POST",
            headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + githubToken, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
            body: JSON.stringify({ ref: "main" }),
            signal: AbortSignal.timeout(5000),
          });
          if (!dispatch.ok) console.error("WatchIndex dispatch failed:", dispatch.status, (await dispatch.text()).slice(0, 250));
        } catch (dispatchError) { console.error("WatchIndex dispatch error:", dispatchError); }
      } else console.error("STOCK_ANALYSER_GITHUB_TOKEN is missing; WatchIndex refresh cannot be triggered.");
    }
    return json({
      items: items.map((item) => {
        const row: any = byTicker.get(item.ticker);
        return {
          ticker: item.ticker,
          added_at: item.created_at,
          analysis: compactAnalysis(row?.result, row?.indexed_at ?? null),
          indexed_at: row?.indexed_at ?? null,
          index_fresh: Boolean(row?.indexed_at && new Date(row.indexed_at).getTime() >= sixHoursAgo),
          awaiting_watchindex: staleTickers.includes(item.ticker),
        };
      }),
      refreshing: staleTickers.length > 0,
    });
  } catch (error) {
    console.error("watchlist error:", error);
    const message = error instanceof Error ? error.message : "Could not update the watchlist.";
    return json({ error: message }, message.includes("not configured") ? 503 : 500);
  }
});
