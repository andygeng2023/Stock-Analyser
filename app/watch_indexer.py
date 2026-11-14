"""WatchIndex worker using TiDB directly."""
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

from .analyzer import analyze_ticker
from .db import fetch_all, insert_one, verify_database
from .worker import request_json, upsert_market_index

PERIOD, HORIZON = "5y", 30
RECENT_HOURS, POLL_SECONDS = 6, 60
RETRY_FAILED_SECONDS = 1800
MAX_RUNTIME_SECONDS = 345 * 60


def watchlist_tickers():
    rows = fetch_all("SELECT DISTINCT ticker FROM watchlist_items WHERE ticker IS NOT NULL ORDER BY ticker")
    return [r["ticker"] for r in rows if isinstance(r.get("ticker"), str) and r["ticker"]]


def recent_rapid_index(tickers):
    if not tickers:
        return {}
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=RECENT_HOURS)).isoformat()
    marks = ",".join(["%s"] * len(tickers))
    rows = fetch_all(
        f"""SELECT ticker,indexed_at FROM market_index
            WHERE ticker IN ({marks}) AND period=%s AND horizon=%s
              AND indexer=%s AND indexed_at >= %s""",
        (*tickers, PERIOD, HORIZON, "rapidIndex", cutoff),
    )
    return {r["ticker"]: r.get("indexed_at") for r in rows}


def save_analysis(ticker, result):
    now, job_id = datetime.now(timezone.utc).isoformat(), str(uuid.uuid4())
    insert_one("analysis_jobs", {
        "id": job_id, "ticker": ticker, "period": PERIOD, "horizon": HORIZON,
        "job_type": "analysis", "scan_source": "both", "save_to_indexer": "rapidIndex",
        "status": "completed", "result": result, "error": None,
        "client_ip_hash": "watch-indexer", "attempts": 1, "progress": 100,
        "stage": "Completed by WatchIndex", "created_at": now, "updated_at": now,
    })
    upsert_market_index(job_id, ticker, PERIOD, HORIZON, result, "rapidIndex")


def run_once(failed_until):
    tickers = watchlist_tickers()
    if not tickers:
        print("No authenticated watchlists currently contain stocks.")
        return 0
    recent = recent_rapid_index(tickers)
    pending = [t for t in tickers if t not in recent and failed_until.get(t, 0) <= time.monotonic()]
    print(f"Watchlist stocks={len(tickers)}; fresh RapidIndex={len(recent)}; pending={len(pending)}.")
    completed = 0
    for i, ticker in enumerate(pending, 1):
        print(f"[{i}/{len(pending)}] WatchIndex analysing {ticker}.")
        try:
            save_analysis(ticker, analyze_ticker(ticker, period=PERIOD, horizon=HORIZON))
            recent[ticker] = datetime.now(timezone.utc).isoformat()
            failed_until.pop(ticker, None)
            completed += 1
        except Exception as exc:
            failed_until[ticker] = time.monotonic() + RETRY_FAILED_SECONDS
            print(f"WatchIndex failed for {ticker}: {str(exc)[:250]}", file=sys.stderr)
    return completed


def dispatch_successor():
    request_json(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/actions/workflows/watch-index.yml/dispatches",
        method="POST", payload={"ref": os.environ.get("GITHUB_REF_NAME", "main")},
        headers={"Accept": "application/vnd.github+json",
                 "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
                 "X-GitHub-Api-Version": "2022-11-28"},
    )


def main():
    if not os.environ.get("DATABASE_URL") or not os.environ.get("GITHUB_TOKEN"):
        raise RuntimeError("DATABASE_URL and GITHUB_TOKEN are required.")
    print("Database preflight:", verify_database())
    started, failed_until = time.monotonic(), {}
    print("WatchIndex worker started against TiDB.")
    while time.monotonic() - started < MAX_RUNTIME_SECONDS:
        try:
            run_once(failed_until)
        except Exception as exc:
            print(f"WatchIndex cycle failed: {str(exc)[:300]}", file=sys.stderr)
        time.sleep(min(POLL_SECONDS, max(0, MAX_RUNTIME_SECONDS - (time.monotonic() - started))))
    dispatch_successor()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
