import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

let schemaReady = false;

function databaseUrl() {
  const raw = Deno.env.get("TURSO_DATABASE_URL");
  if (!raw) throw new Error("Watchlist SQLite is not configured. Add TURSO_DATABASE_URL.");
  return raw.replace(/^libsql:\/\//, "https://").replace(/\/$/, "");
}
function authToken() {
  const value = Deno.env.get("TURSO_AUTH_TOKEN");
  if (!value) throw new Error("Watchlist SQLite is not configured. Add TURSO_AUTH_TOKEN.");
  return value;
}
function encodeArg(value: string | number) {
  return typeof value === "number"
    ? { type: "integer", value: String(value) }
    : { type: "text", value };
}
function decodeCell(cell: any): unknown {
  if (!cell || cell.type === "null") return null;
  if (cell.type === "integer" || cell.type === "float") return Number(cell.value);
  return cell.value ?? null;
}
async function tursoExecute(sql: string, args: (string | number)[] = [], wantRows = true) {
  const response = await fetch(databaseUrl() + "/v3/pipeline", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + authToken(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      baton: null,
      requests: [
        { type: "execute", stmt: { sql, args: args.map(encodeArg), want_rows: wantRows } },
        { type: "close" },
      ],
    }),
  });
  if (!response.ok) throw new Error("Watchlist SQLite request failed (" + response.status + ").");
  const data = await response.json();
  const first = data.results?.[0];
  if (!first || first.type !== "ok" || first.response?.type !== "execute") {
    throw new Error(first?.error?.message || "Watchlist SQLite query failed.");
  }
  const result = first.response.result;
  const columns = (result.cols || []).map((column: any) => column.name);
  return {
    rows: (result.rows || []).map((row: any[]) =>
      Object.fromEntries(row.map((cell, index) => [columns[index], decodeCell(cell)]))
    ),
    affected: Number(result.affected_row_count || 0),
  };
}
async function ensureSchema() {
  if (schemaReady) return;
  await tursoExecute(
    `CREATE TABLE IF NOT EXISTS watchlist_items (
      owner_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (owner_id, ticker)
    )`,
    [],
    false,
  );
  await tursoExecute(
    "CREATE INDEX IF NOT EXISTS watchlist_items_ticker_idx ON watchlist_items(ticker)",
    [],
    false,
  );
  schemaReady = true;
}
function validUserId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function normaliseTicker(value: unknown): string {
  const ticker = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9.^=-]{1,20}$/.test(ticker)) throw new Error("Enter a valid ticker.");
  return ticker;
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
    market_summary: result.market_summary ?? {},
    fundamentals: {
      market_cap: result.fundamentals?.market_cap ?? null,
      sector: result.fundamentals?.sector ?? null,
      industry: result.fundamentals?.industry ?? null,
      profit_margin: result.fundamentals?.profit_margin ?? null,
      return_on_equity: result.fundamentals?.return_on_equity ?? null,
    },
    model: {
      metrics: { hybrid: result.model?.metrics?.hybrid ?? {} },
    },
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
    const body = await req.json();
    const action = String(body.action ?? "");
    const ownerId = body.user_id;
    if (!validUserId(ownerId)) return json({ error: "Invalid watchlist identity. Refresh the page and try again." }, 400);
    if (!["list", "add", "remove"].includes(action)) return json({ error: "Unknown watchlist action." }, 400);

    await ensureSchema();

    if (action === "add") {
      const ticker = normaliseTicker(body.ticker);
      const count = await tursoExecute(
        "SELECT COUNT(*) AS total FROM watchlist_items WHERE owner_id = ?",
        [ownerId],
      );
      if (Number(count.rows[0]?.total || 0) >= 100) {
        const existing = await tursoExecute(
          "SELECT 1 AS found FROM watchlist_items WHERE owner_id = ? AND ticker = ? LIMIT 1",
          [ownerId, ticker],
        );
        if (!existing.rows.length) return json({ error: "A watchlist can contain up to 100 stocks." }, 409);
      }
      await tursoExecute(
        "INSERT INTO watchlist_items (owner_id, ticker, added_at) VALUES (?, ?, ?) ON CONFLICT(owner_id, ticker) DO NOTHING",
        [ownerId, ticker, new Date().toISOString()],
        false,
      );
      return json({ success: true, ticker });
    }

    if (action === "remove") {
      const ticker = normaliseTicker(body.ticker);
      await tursoExecute(
        "DELETE FROM watchlist_items WHERE owner_id = ? AND ticker = ?",
        [ownerId, ticker],
        false,
      );
      return json({ success: true, ticker });
    }

    const list = await tursoExecute(
      "SELECT ticker, added_at FROM watchlist_items WHERE owner_id = ? ORDER BY added_at DESC",
      [ownerId],
    );
    const items = list.rows as { ticker: string; added_at: string }[];
    if (!items.length) return json({ items: [] });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) throw new Error("Market data service is not configured.");
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const tickers = items.map((item) => item.ticker);
    const { data: indexed, error } = await admin.from("market_index")
      .select("ticker,result,indexed_at")
      .in("ticker", tickers)
      .eq("period", "5y")
      .eq("horizon", 30)
      .eq("indexer", "rapidIndex");
    if (error) throw error;
    const byTicker = new Map((indexed ?? []).map((row: any) => [row.ticker, row]));
    return json({
      items: items.map((item) => {
        const row: any = byTicker.get(item.ticker);
        return {
          ticker: item.ticker,
          added_at: item.added_at,
          analysis: compactAnalysis(row?.result, row?.indexed_at ?? null),
        };
      }),
    });
  } catch (error) {
    console.error("watchlist error:", error);
    const message = error instanceof Error ? error.message : "Could not update the watchlist.";
    const status = message.includes("not configured") ? 503 : 500;
    return json({ error: message }, status);
  }
});
