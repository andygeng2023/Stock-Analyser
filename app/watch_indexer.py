"""Long-running WatchIndex worker backed by Supabase Postgres watchlists."""
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from .analyzer import analyze_ticker
from .worker import supabase_request, upsert_market_index

PERIOD = "5y"
HORIZON = 30
RECENT_HOURS = 6
POLL_SECONDS = 60
RETRY_FAILED_SECONDS = 30 * 60
MAX_RUNTIME_SECONDS = 345 * 60


def watchlist_tickers():
    """Read every authenticated user's watchlist and return unique tickers."""
    tickers = set()
    offset = 0
    page_size = 1000
    while True:
        rows = supabase_request(
            "watchlist_items?select=ticker&order=created_at.asc"
            f"&limit={page_size}&offset={offset}"
        )
        if not rows:
            break
        tickers.update(
            row["ticker"] for row in rows
            if isinstance(row.get("ticker"), str) and row["ticker"]
        )
        if len(rows) < page_size:
            break
        offset += page_size
    return sorted(tickers)


def recent_rapid_index(tickers):
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=RECENT_HOURS)).isoformat()
    encoded = quote(cutoff, safe="")
    recent = {}
    # Restrict each query to this watchlist universe so PostgREST row limits
    # cannot hide recently indexed tickers behind unrelated market symbols.
    for start in range(0, len(tickers), 100):
        batch = tickers[start:start + 100]
        if not batch:
            continue
        symbols = ",".join(batch)
        rows = supabase_request(
            "market_index?select=ticker,indexed_at"
            f"&ticker=in.({symbols})"
            f"&period=eq.{PERIOD}&horizon=eq.{HORIZON}"
            "&indexer=eq.rapidIndex"
            f"&indexed_at=gte.{encoded}&limit=1000"
        )
        recent.update({row["ticker"]: row.get("indexed_at") for row in rows or []})
    return recent


def save_analysis(ticker, result):
    now = datetime.now(timezone.utc).isoformat()
    job_id = str(uuid.uuid4())
    payload = {
        "id": job_id,
        "ticker": ticker,
        "period": PERIOD,
        "horizon": HORIZON,
        "job_type": "analysis",
        "scan_source": "both",
        "save_to_indexer": "rapidIndex",
        "status": "completed",
        "result": result,
        "error": None,
        "client_ip_hash": "watch-indexer",
        "attempts": 1,
        "progress": 100,
        "stage": "Completed by WatchIndex",
        "created_at": now,
        "updated_at": now,
    }
    supabase_request("analysis_jobs", method="POST", payload=payload)
    upsert_market_index(job_id, ticker, PERIOD, HORIZON, result, "rapidIndex")


def run_once(failed_until):
    tickers = watchlist_tickers()
    if not tickers:
        print("No authenticated watchlists currently contain stocks.")
        return 0

    recent = recent_rapid_index(tickers)
    pending = [
        ticker for ticker in tickers
        if ticker not in recent and failed_until.get(ticker, 0) <= time.monotonic()
    ]
    print(
        f"Watchlist universe={len(tickers)} unique tickers; "
        f"{len(recent)} already have a RapidIndex result younger than six hours; "
        f"{len(pending)} need analysis."
    )

    completed = 0
    for position, ticker in enumerate(pending, start=1):
        print(f"[{position}/{len(pending)}] WatchIndex analysing {ticker}.")
        try:
            result = analyze_ticker(ticker, period=PERIOD, horizon=HORIZON)
            save_analysis(ticker, result)
            recent[ticker] = datetime.now(timezone.utc).isoformat()
            failed_until.pop(ticker, None)
            completed += 1
        except Exception as exc:
            failed_until[ticker] = time.monotonic() + RETRY_FAILED_SECONDS
            print(f"WatchIndex failed for {ticker}: {str(exc)[:250]}", file=sys.stderr)
    print(f"WatchIndex completed {completed}/{len(pending)} refreshes.")
    return completed


def dispatch_successor():
    from .worker import request_json
    token = os.environ["GITHUB_TOKEN"]
    repository = os.environ["GITHUB_REPOSITORY"]
    ref = os.environ.get("GITHUB_REF_NAME", "main")
    request_json(
        f"https://api.github.com/repos/{repository}/actions/workflows/watch-index.yml/dispatches",
        method="POST",
        payload={"ref": ref},
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    print("Successor WatchIndex run dispatched.")


def main():
    required = ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GITHUB_TOKEN")
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        print("Missing WatchIndex secrets: " + ", ".join(missing), file=sys.stderr)
        return 1

    started = time.monotonic()
    failed_until = {}
    print("WatchIndex worker started. It checks all authenticated watchlists and shares RapidIndex cache.")
    while time.monotonic() - started < MAX_RUNTIME_SECONDS:
        try:
            run_once(failed_until)
        except Exception as exc:
            print(f"WatchIndex cycle failed: {str(exc)[:300]}", file=sys.stderr)
        remaining = MAX_RUNTIME_SECONDS - (time.monotonic() - started)
        if remaining > 0:
            time.sleep(min(POLL_SECONDS, remaining))

    try:
        dispatch_successor()
    except Exception as exc:
        print(f"Could not dispatch successor WatchIndex run: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
