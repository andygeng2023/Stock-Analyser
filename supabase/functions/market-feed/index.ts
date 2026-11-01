import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Cache-Control": "public, max-age=60, s-maxage=60" },
  });

const number = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !serviceKey) return json({ error: "Market feed is not configured." }, 503);

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const cutoff = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

    const [indexResponse, scanResponse] = await Promise.all([
      admin.from("market_index")
        .select("ticker,indexed_at,market_cap,avg_dollar_volume,priority,result")
        .eq("period", "5y")
        .eq("horizon", 30)
        .gte("indexed_at", cutoff)
        .order("indexed_at", { ascending: false })
        .limit(1500),
      admin.from("analysis_jobs")
        .select("created_at,result")
        .eq("job_type", "scan")
        .eq("status", "completed")
        .not("result", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (indexResponse.error) throw indexResponse.error;
    if (scanResponse.error) throw scanResponse.error;

    const records = (indexResponse.data ?? []).map((row: any) => {
      const result = row.result ?? {};
      const fundamentals = result.fundamentals ?? {};
      const market = result.market_summary ?? {};
      const metrics = result.model?.metrics?.hybrid ?? {};
      const forecast = result.forecast ?? {};
      const marketCap = number(row.market_cap ?? fundamentals.market_cap, 0);
      const dollarVolume = number(row.avg_dollar_volume, 0);
      const return1m = number(market.return_1m, 0);
      const return1y = number(market.return_1y, 0);
      const volatility = number(market.annualized_volatility, 100);
      const drawdown = number(market.max_drawdown, -100);
      const profitMargin = number(fundamentals.profit_margin, -1);
      const roe = number(fundamentals.return_on_equity, -1);
      const expectedChange = number(forecast.expected_change_percent, 0);
      const directionalAccuracy = number(metrics.directional_accuracy, 0);

      // This is an editorial screening score, not a predicted return or rating.
      const qualityScore =
        clamp((return1m + 10) / 40, 0, 1) * 25 +
        clamp((roe + 0.1) / 0.5, 0, 1) * 20 +
        clamp((profitMargin + 0.05) / 0.25, 0, 1) * 15 +
        clamp((70 - volatility) / 50, 0, 1) * 20 +
        clamp((drawdown + 70) / 70, 0, 1) * 20;

      return {
        ticker: row.ticker,
        company: result.company || row.ticker,
        exchange: result.exchange ?? null,
        currency: result.currency || "USD",
        price: result.price ?? null,
        change_percent: result.change_percent ?? null,
        market_cap: marketCap || null,
        avg_dollar_volume: dollarVolume || null,
        return_1m: return1m,
        return_1y: return1y,
        annualized_volatility: volatility,
        max_drawdown: drawdown,
        profit_margin: profitMargin,
        return_on_equity: roe,
        expected_change_percent: expectedChange,
        directional_accuracy: directionalAccuracy,
        sector: fundamentals.sector ?? null,
        industry: fundamentals.industry ?? null,
        indexed_at: row.indexed_at,
        quality_score: Math.round(qualityScore * 100) / 100,
      };
    });

    const unique = new Map<string, any>();
    for (const record of records) {
      if (!unique.has(record.ticker)) unique.set(record.ticker, record);
    }
    const stocks = [...unique.values()];
    const liquid = stocks.filter((s) => s.avg_dollar_volume >= 2_000_000 && s.market_cap >= 100_000_000);
    const smaller = liquid.filter((s) => s.market_cap < 2_000_000_000);
    const healthySmaller = smaller.filter((s) =>
      s.return_1m > 0 &&
      s.profit_margin > 0 &&
      s.return_on_equity > 0 &&
      s.annualized_volatility <= 70 &&
      s.max_drawdown >= -75
    );

    const recommended = stocks
      .filter((s) =>
        s.avg_dollar_volume >= 2_000_000 &&
        s.market_cap >= 100_000_000 &&
        s.return_1m > 0 &&
        s.profit_margin > 0 &&
        s.return_on_equity > 0 &&
        s.annualized_volatility <= 65 &&
        s.max_drawdown >= -70 &&
        s.directional_accuracy >= 50
      )
      .sort((a, b) => b.quality_score - a.quality_score)
      .slice(0, 8);

    const trending = stocks
      .filter((s) => s.return_1m > 0 && s.avg_dollar_volume >= 2_000_000)
      .sort((a, b) => b.return_1m - a.return_1m)
      .slice(0, 8);

    const popular = stocks
      .filter((s) => s.market_cap > 0 && s.avg_dollar_volume > 0)
      .sort((a, b) =>
        (Math.log10(b.market_cap) * 0.55 + Math.log10(b.avg_dollar_volume) * 0.45) -
        (Math.log10(a.market_cap) * 0.55 + Math.log10(a.avg_dollar_volume) * 0.45)
      )
      .slice(0, 8);

    const opportunities = healthySmaller
      .sort((a, b) => b.quality_score - a.quality_score)
      .slice(0, 8);

    const smallerCompanies = smaller
      .sort((a, b) => b.quality_score - a.quality_score)
      .slice(0, 12);

    const scanRow = scanResponse.data;
    const rawScan = scanRow?.result ?? null;
    const latestScan = rawScan && Array.isArray(rawScan.results)
      ? {
          as_of: rawScan.as_of ?? scanRow.created_at,
          created_at: scanRow.created_at,
          universe_size: rawScan.universe_size ?? null,
          results: rawScan.results.slice(0, 8).map((item: any) => ({
            ticker: item.ticker,
            company: item.company || item.ticker,
            exchange: item.exchange ?? null,
            currency: item.currency || "USD",
            price: item.price ?? null,
            change_percent: item.change_percent ?? null,
            expected_change_percent: item.expected_change_percent ?? null,
            directional_accuracy: item.directional_accuracy ?? null,
          })),
        }
      : null;

    return json({
      generated_at: new Date().toISOString(),
      indexed_count: stocks.length,
      small_company_count: smaller.length,
      quality_small_company_count: healthySmaller.length,
      latest_scan: latestScan,
      recommended,
      trending,
      popular,
      opportunities,
      smaller_companies: smallerCompanies,
    });
  } catch (error) {
    console.error("market-feed error:", error);
    return json({ error: "Could not load market overview." }, 500);
  }
});
