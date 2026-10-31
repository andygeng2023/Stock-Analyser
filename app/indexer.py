"""Scheduled incremental market indexer.

Each scheduled shard ranks the current liquid universe, prioritises never/least
recently indexed names, and computes a bounded number of full baseline analyses.
"""
import os
import sys
from datetime import datetime, timezone

import yfinance as yf

from .analyzer import analyze_ticker
from .scanner import load_universe, fast_filter
from .worker import request_json

PER_SHARD_LIMIT = 15
MARKET_CAP_LOOKUPS = 250
PERIOD = "5y"
HORIZON = 30


def db_get(path):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return request_json(f"{base}/rest/v1/{path}", headers={
        "apikey": key, "Authorization": f"Bearer {key}",
    })


def db_post(path, payload, *, conflict=None):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    url = f"{base}/rest/v1/{path}"
    if conflict:
        url += "?on_conflict=" + conflict
    return request_json(url, method="POST", payload=payload, headers={
        "apikey": key, "Authorization": f"Bearer {key}",
        "Prefer": "resolution=merge-duplicates,return=representation",
    })


def market_cap_for(ticker):
    try:
        info = yf.Ticker(ticker).fast_info
        value = info.get("market_cap") or info.get("marketCap")
        return float(value) if value is not None else None
    except Exception:
        return None


def run(shard):
    shard_count = 2
    if shard < 0 or shard >= shard_count:
        raise ValueError("Invalid indexer shard.")
    print(f"Market indexer shard {shard + 1}/{shard_count} discovering universe.")
    symbols = load_universe("both")
    ranked, eligible = fast_filter(symbols)
    if not ranked:
        print("No eligible stocks found; nothing to index.")
        return 0

    catalog_rows = db_get("market_index_catalog?select=ticker,last_indexed_at,market_cap&limit=10000")
    catalog = {row["ticker"]: row for row in catalog_rows or []}

    # Enrich a bounded liquid subset with Yahoo's market-cap metadata. If it is
    # unavailable, liquidity and the fast-screen score remain the fallback.
    for item in ranked[:MARKET_CAP_LOOKUPS]:
        old = catalog.get(item["ticker"], {})
        cap = old.get("market_cap") or market_cap_for(item["ticker"])
        item["market_cap"] = cap
        if cap is not None:
            catalog.setdefault(item["ticker"], {})["market_cap"] = cap

    # Keep the rotation cursor in the catalogue after the eight-hour result
    # itself expires, so the same mega-caps are not re-indexed every cycle.
    now = datetime.now(timezone.utc).isoformat()
    metadata = []
    for item in ranked:
        ticker = item["ticker"]
        old = catalog.get(ticker, {})
        metadata.append({
            "ticker": ticker,
            "market_cap": item.get("market_cap") or old.get("market_cap"),
            "avg_dollar_volume": item.get("dollar_volume"),
            "priority": float(item.get("fast_score") or 0),
            "last_indexed_at": old.get("last_indexed_at"),
            "updated_at": now,
        })
    for start in range(0, len(metadata), 500):
        db_post("market_index_catalog", metadata[start:start + 500], conflict="ticker")

    def sort_key(item):
        last = catalog.get(item["ticker"], {}).get("last_indexed_at")
        # Never indexed first, then oldest index timestamp, then market value
        # and liquidity. This gradually rotates through the eligible universe.
        return (
            last or "",
            -(item.get("market_cap") or 0),
            -(item.get("dollar_volume") or 0),
            -(item.get("fast_score") or 0),
        )

    candidates = sorted(ranked, key=sort_key)
    shard_candidates = candidates[shard::shard_count][:PER_SHARD_LIMIT]
    print(f"Universe={len(symbols)}, eligible={eligible}, shard candidates={len(shard_candidates)}.")
    completed = 0
    for position, item in enumerate(shard_candidates, start=1):
        ticker = item["ticker"]
        print(f"[{position}/{len(shard_candidates)}] Indexing {ticker}.")
        try:
            result = analyze_ticker(ticker, period=PERIOD, horizon=HORIZON)
            job = db_post("analysis_jobs", {
                "ticker": ticker, "period": PERIOD, "horizon": HORIZON,
                "job_type": "analysis", "scan_source": "both",
                "status": "completed", "result": result, "error": None,
                "client_ip_hash": "market-indexer", "attempts": 1,
                "progress": 100, "stage": "Completed by scheduled market indexer",
            })
            job_id = job[0]["id"]
            cap = item.get("market_cap")
            index_row = {
                "ticker": ticker, "period": PERIOD, "horizon": HORIZON,
                "result": result, "source_job_id": job_id,
                "indexed_at": datetime.now(timezone.utc).isoformat(),
                "market_cap": cap, "avg_dollar_volume": item.get("dollar_volume"),
                "priority": float(item.get("fast_score") or 0),
            }
            db_post("market_index", index_row, conflict="ticker,period,horizon")
            db_post("market_index_catalog", {
                "ticker": ticker, "market_cap": cap,
                "avg_dollar_volume": item.get("dollar_volume"),
                "priority": float(item.get("fast_score") or 0),
                "last_indexed_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }, conflict="ticker")
            completed += 1
        except Exception as exc:
            print(f"Indexing failed for {ticker}: {str(exc)[:250]}", file=sys.stderr)
    print(f"Shard {shard + 1} indexed {completed}/{len(shard_candidates)} stocks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(run(int(os.environ.get("INDEX_SHARD", "0"))))
