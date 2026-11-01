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
async function yahooQuote(ticker: string) {
  const url = new URL("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(ticker));
  url.searchParams.set("range", "5d");
  url.searchParams.set("interval", "5m");
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 StockAnalyser/1.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(4500),
  });
  if (!response.ok) throw new Error("Yahoo Finance returned " + response.status);
  const body = await response.json();
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error(body?.chart?.error?.description || "No quote available.");
  const latest = Number(result.meta?.regularMarketPrice);
  const previous = Number(result.meta?.chartPreviousClose ?? result.meta?.previousClose);
  return {
    price: Number.isFinite(latest) ? latest : null,
    change_percent: Number.isFinite(latest) && Number.isFinite(previous) && previous !== 0
      ? ((latest / previous) - 1) * 100 : null,
    currency: result.meta?.currency || "USD",
    as_of: result.meta?.regularMarketTime
      ? new Date(Number(result.meta.regularMarketTime) * 1000).toISOString() : null,
  };
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

async function loadIndexedResults(admin: any, tickers: string[]) {
  const { data: indexed, error } = await admin.from("market_index")
    .select("ticker,result,indexed_at")
    .in("ticker", tickers)
    .eq("period", "5y").eq("horizon", 30).eq("indexer", "rapidIndex");
  if (error) throw error;
  const byTicker = new Map<string, any>((indexed ?? []).map((row: any) => [row.ticker, row]));

  // Some completed analyses predate or failed to populate the index row.
  const missingFromIndex = tickers.filter((ticker) => !byTicker.has(ticker));
  if (missingFromIndex.length) {
    const { data: jobs, error: jobsError } = await admin.from("analysis_jobs")
      .select("ticker,result,created_at")
      .in("ticker", missingFromIndex)
      .eq("job_type", "analysis").eq("period", "5y").eq("horizon", 30)
      .eq("status", "completed").not("result", "is", null)
      .order("created_at", { ascending: false }).limit(1000);
    if (jobsError) throw jobsError;
    for (const job of jobs ?? []) {
      if (!byTicker.has(job.ticker)) {
        byTicker.set(job.ticker, { ticker: job.ticker, result: job.result, indexed_at: job.created_at });
      }
    }
  }
  return byTicker;
}

function indexedCardItem(ticker: string, row: any) {
  const cached: any = row?.result ?? {};
  const cachedHistory = sample(cached.history?.close ?? cached.history_preview ??
    cached.historical?.close ?? cached.price_history);
  const cachedForecast = sample(cached.forecast?.hybrid ?? cached.forecast_preview ??
    cached.forecast?.forecast_path, 30);
  const cachedSummary = cached.market_summary ?? {};
  return {
    ticker,
    company: cached.company || cached.name || ticker,
    currency: cached.currency || "USD",
    price: cached.price ?? null,
    change_percent: cached.change_percent ?? null,
    history_preview: cachedHistory,
    forecast_preview: cachedForecast,
    expected_change_percent: cached.forecast?.expected_change_percent ?? cached.expected_change_percent ?? null,
    return_1m: cachedSummary.return_1m ?? null,
    directional_accuracy: cached.model?.metrics?.hybrid?.directional_accuracy ?? null,
    annualized_volatility: cachedSummary.annualized_volatility ?? null,
    indexed_at: row?.indexed_at ?? null,
    has_indexed_chart: cachedHistory.length > 0,
    source: row ? "RapidIndex shared cache" : "not indexed",
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

    const requestedMode = String(body.mode ?? "both").toLowerCase();
    const mode = ["indexed", "quotes", "history", "both"].includes(requestedMode)
      ? requestedMode : "both";

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) return json({ error: "Market data is not configured." }, 503);

    // Quotes and historical fallback are deliberately independent from the indexed-chart path.
    if (mode === "quotes") {
      const items = await Promise.all(tickers.map(async (ticker) => {
        try {
          return { ticker, ...(await yahooQuote(ticker)) };
        } catch (error) {
          console.warn("Yahoo Finance quote failed for " + ticker + ":", error);
          return { ticker, price: null, change_percent: null, currency: null, as_of: null };
        }
      }));
      return json({ items, generated_at: new Date().toISOString(), mode });
    }

    if (mode === "history") {
      const items = await Promise.all(tickers.map(async (ticker) => {
        try {
          return await yahooHistory(ticker);
        } catch (error) {
          console.warn("Yahoo Finance historical fallback failed for " + ticker + ":", error);
          return { ticker, history_preview: [], price: null, change_percent: null, currency: null, source: "unavailable" };
        }
      }));
      return json({ items, generated_at: new Date().toISOString(), mode });
    }

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const byTicker = await loadIndexedResults(admin, tickers);

    if (mode === "indexed") {
      const items = tickers.map((ticker) => indexedCardItem(ticker, byTicker.get(ticker)));
      return json({ items, generated_at: new Date().toISOString(), mode });
    }

    // Backwards-compatible mode for existing callers: return an indexed chart with
    // a live quote, falling back to Yahoo historical prices only when no index exists.
    const items = await Promise.all(tickers.map(async (ticker) => {
      const indexed = indexedCardItem(ticker, byTicker.get(ticker));
      if (indexed.history_preview.length) {
        try {
          const live = await yahooQuote(ticker);
          return {
            ...indexed,
            currency: live.currency || indexed.currency,
            price: live.price ?? indexed.price,
            change_percent: live.change_percent ?? indexed.change_percent,
            as_of: live.as_of,
            source: "RapidIndex shared cache + live quote",
          };
        } catch (error) {
          console.warn("Yahoo Finance refresh failed for " + ticker + ":", error);
          return indexed;
        }
      }
      try {
        const historical = await yahooHistory(ticker);
        return { ...indexed, ...historical, forecast_preview: [], source: historical.source };
      } catch (error) {
        console.warn("Yahoo Finance historical fallback failed for " + ticker + ":", error);
        return indexed;
      }
    }));
    return json({ items, generated_at: new Date().toISOString(), mode });
  } catch (error) {
    console.error("stock-market-data error:", error);
    return json({ error: error instanceof Error ? error.message : "Could not load market data." }, 500);
  }
});
