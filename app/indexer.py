"""Scheduled incremental market indexer.

Each scheduled shard ranks the current liquid universe, prioritises never/least
recently indexed names, and computes a bounded number of full baseline analyses.
"""
import os
import sys
import time
import threading
from datetime import datetime, timezone

import yfinance as yf

from .analyzer import analyze_ticker
from .scanner import load_universe, fast_filter
from .worker import request_json

PER_SHARD_LIMIT = 15
MARKET_CAP_LOOKUPS = 250
PRIORITY_REFRESH_COUNT = 20
REFRESH_AFTER_HOURS = 6.0
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

    # Keep catalogue metadata after cache expiry, and use it as the fair-rotation cursor.
    now_dt = datetime.now(timezone.utc)
    now = now_dt.isoformat()
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

    # Read the live cache separately from the catalogue. The catalogue survives
    # the eight-hour expiry; market_index tells us whether a usable result exists.
    live_rows = db_get(
        f"market_index?select=ticker,indexed_at,market_cap,avg_dollar_volume,priority"
        f"&period=eq.{PERIOD}&horizon=eq.{HORIZON}&limit=10000"
    )
    live_index = {row["ticker"]: row for row in (live_rows or [])}

    def parse_time(value):
        if not value:
            return None
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None

    # Composite quality rank: market value and liquidity dominate; recent
    # momentum/trend is a smaller tie-breaker, not a forecast recommendation.
    def percentile(values, value):
        if value is None or not values:
            return 0.0
        ordered = sorted(values)
        lo, hi = 0, len(ordered)
        while lo < hi:
            mid = (lo + hi) // 2
            if ordered[mid] <= value:
                lo = mid + 1
            else:
                hi = mid
        return lo / len(ordered)

    cap_values = [float(x.get("market_cap")) for x in ranked if x.get("market_cap") is not None]
    volume_values = [float(x.get("dollar_volume") or 0) for x in ranked]
    momentum_values = [float(x.get("fast_score") or 0) for x in ranked]
    for item in ranked:
        old = catalog.get(item["ticker"], {})
        cap = item.get("market_cap") or old.get("market_cap")
        item["_quality"] = (
            0.45 * percentile(cap_values, float(cap) if cap is not None else None)
            + 0.35 * percentile(volume_values, float(item.get("dollar_volume") or 0))
            + 0.20 * percentile(momentum_values, float(item.get("fast_score") or 0))
        )
        live = live_index.get(item["ticker"])
        indexed_at = parse_time((live or {}).get("indexed_at"))
        item["_indexed_at"] = indexed_at
        item["_age_hours"] = (
            (now_dt - indexed_at).total_seconds() / 3600 if indexed_at else None
        )

    # Track A: protect a small high-value/high-liquidity cohort. Refresh its
    # entries at six hours, leaving a two-hour margin before the cache expires.
    elite = sorted(ranked, key=lambda x: x["_quality"], reverse=True)[:PRIORITY_REFRESH_COUNT]
    refresh_due = [
        item for item in elite
        if item["_indexed_at"] is None or item["_age_hours"] >= REFRESH_AFTER_HOURS
    ]
    refresh_due.sort(key=lambda x: (
        -(x["_age_hours"] if x["_age_hours"] is not None else 9999),
        -x["_quality"],
    ))

    # Track B: spend remaining compute expanding coverage. The persistent
    # catalogue cursor prevents the same names being chosen repeatedly, while
    # market-cap/liquidity/fast-screen quality breaks ties.
    elite_tickers = {item["ticker"] for item in elite}
    discovery = [item for item in ranked if item["ticker"] not in {x["ticker"] for x in refresh_due}]
    def discovery_key(item):
        last = parse_time(catalog.get(item["ticker"], {}).get("last_indexed_at"))
        # Never/least-recently processed names first; stronger names win ties.
        age = (now_dt - last).total_seconds() if last else float("inf")
        return (-age, -item["_quality"])
    discovery.sort(key=discovery_key)

    ordered = refresh_due + discovery
    # Stable two-way sharding keeps workers disjoint. Each cycle takes a small
    # batch; main() repeats batches until the pre-timeout hand-off window.
    candidates = ordered[shard::shard_count]
    shard_candidates = candidates[:PER_SHARD_LIMIT]
    print(
        f"Universe={len(symbols)}, eligible={eligible}, "
        f"priority refresh due={len(refresh_due)}, "
        f"elite cohort={len(elite)}, shard candidates={len(shard_candidates)}."
    )
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


def dispatch_successor():
    token = os.environ["GITHUB_TOKEN"]
    repository = os.environ["GITHUB_REPOSITORY"]
    ref = os.environ.get("GITHUB_REF_NAME", "main")
    request_json(
        f"https://api.github.com/repos/{repository}/actions/workflows/index-market.yml/dispatches",
        method="POST",
        payload={"ref": ref},
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    print("Successor indexer workflow dispatched for a graceful six-hour hand-off.")


def _handoff_after_runtime():
    time.sleep(340 * 60)
    try:
        dispatch_successor()
    except Exception as exc:
        print(f"Could not dispatch successor indexer: {exc}", file=sys.stderr)


def main():
    shard = int(os.environ.get("INDEX_SHARD", "0"))
    if shard == 0:
        threading.Thread(target=_handoff_after_runtime, daemon=True).start()
    started = time.monotonic()
    while time.monotonic() - started < 345 * 60:
        try:
            run(shard)
        except Exception as exc:
            print(f"Indexing cycle failed: {str(exc)[:300]}", file=sys.stderr)
        if time.monotonic() - started < 345 * 60:
            print("Indexing cycle complete; pausing 90 seconds before the next rotation.")
            time.sleep(90)
    print("Indexer reached its graceful exit window.")

if __name__ == "__main__":
    raise SystemExit(main())
