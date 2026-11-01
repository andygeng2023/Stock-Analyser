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

function normaliseTicker(value: unknown): string | null {
  const ticker = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9.^=-]{1,20}$/.test(ticker) ? ticker : null;
}
function sample(values: unknown, limit = 64): number[] {
  if (!Array.isArray(values)) return [];
  const numeric = values.map(Number).filter(Number.isFinite);
  if (numeric.length <= limit) return numeric;
  return Array.from({ length: limit }, (_, index) =>
    numeric[Math.round(index * (numeric.length - 1) / (limit - 1))]
  );
}
async function yahooHistory(ticker: string) {
  const url = new URL("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker));
  url.searchParams.set("range", "1y");
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 StockAnalyser/1.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error("Yahoo Finance returned " + response.status);
  const body = await response.json();
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description || "No historical data available.");
  const closes: number[] = (result.indicators?.adjclose?.[0]?.adjclose ??
    result.indicators?.quote?.[0]?.close ?? []).filter((value: unknown) =>
      value !== null && value !== undefined && Number.isFinite(Number(value))
    ).map(Number);
  const quote = result.indicators?.quote?.[0] ?? {};
  const latest = Number(result.meta?.regularMarketPrice ?? closes[closes.length - 1]);
  const previous = Number(result.meta?.chartPreviousClose ?? result.meta?.previousClose ??
    closes[closes.length - 2]);
  return {
    ticker,
    price: Number.isFinite(latest) ? latest : null,
    change_percent: Number.isFinite(latest) && Number.isFinite(previous) && previous !== 0
      ? ((latest / previous) - 1) * 100 : null,
    currency: result.meta?.currency || "USD",
    history_preview: sample(closes),
    source: "Yahoo Finance historical data",
    as_of: result.meta?.regularMarketTime
      ? new Date(Number(result.meta.regularMarketTime) * 1000).toISOString() : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  try {
    const body = await req.json();
    const tickers = [...new Set((Array.isArray(body.tickers) ? body.tickers : [])
      .map(normaliseTicker).filter((ticker): ticker is string => Boolean(ticker)))].slice(0, 60);
    if (!tickers.length) return json({ items: [] });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return json({ error: "Market data is not configured." }, 503);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // Prefer the shared RapidIndex cache. Its historical series is the first source.
    const { data: indexed, error } = await admin.from("market_index")
      .select("ticker,result,indexed_at")
      .in("ticker", tickers)
      .eq("period", "5y").eq("horizon", 30).eq("indexer", "rapidIndex");
    if (error) throw error;
    const byTicker = new Map((indexed ?? []).map((row: any) => [row.ticker, row]));
    const items = await Promise.all(tickers.map(async (ticker) => {
      const row: any = byTicker.get(ticker);
      const cached: any = row?.result ?? {};
      const cachedHistory = sample(cached.history?.close);
      // Refresh quote data from Yahoo Finance while preserving cached analysis metrics.
      try {
        const live = await yahooHistory(ticker);
        return {
          ticker,
          company: cached.company || cached.name || ticker,
          currency: live.currency || cached.currency || "USD",
          price: live.price ?? cached.price ?? null,
          change_percent: live.change_percent ?? cached.change_percent ?? null,
          history_preview: cachedHistory.length ? cachedHistory : live.history_preview,
          indexed_at: row?.indexed_at ?? null,
          as_of: live.as_of,
          source: cachedHistory.length ? "shared index + live Yahoo quote" : live.source,
        };
      } catch (error) {
        console.warn("Yahoo Finance refresh failed for " + ticker + ":", error);
        return {
          ticker,
          company: cached.company || cached.name || ticker,
          currency: cached.currency || "USD",
          price: cached.price ?? null,
          change_percent: cached.change_percent ?? null,
          history_preview: cachedHistory,
          indexed_at: row?.indexed_at ?? null,
          source: cachedHistory.length ? "shared index cache" : "unavailable",
        };
      }
    }));
    return json({ items, generated_at: new Date().toISOString() });
  } catch (error) {
    console.error("stock-market-data error:", error);
    return json({ error: error instanceof Error ? error.message : "Could not load market data." }, 500);
  }
});
