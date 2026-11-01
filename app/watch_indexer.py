"""Long-running WatchIndex worker backed by the shared SQLite watchlist."""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from .analyzer import analyze_ticker
from .worker import request_json, supabase_request, upsert_market_index

PERIOD = "5y"
HORIZON = 30
RECENT_HOURS = 6
POLL_SECONDS = 60
RETRY_FAILED_SECONDS = 30 * 60
MAX_RUNTIME_SECONDS = 345 * 60


def turso_url():
    value = os.environ["TURSO_DATABASE_URL"].strip().rstrip("/")
    if value.startswith("libsql://"):
        value = "https://" + value[len("libsql://"):]
    return value


def turso_request(statements):
    token = os.environ["TURSO_AUTH_TOKEN"]
    requests = []
    for statement in statements:
        args = []
        for value in statement.get("args", []):
            if isinstance(value, int):
                args.append({"type": "integer", "value": str(value)})
            else:
                args.append({"type": "text", "value": str(value)})
        requests.append({
            "type": "execute",
            "stmt": {
                "sql": statement["sql"],
                "args": args,
                "want_rows": statement.get("want_rows", True),
            },
        })
    requests.append({"type": "close"})
    body = json.dumps({"baton": None, "requests": requests}).encode()
    request = urllib.request.Request(
        turso_url() + "/v3/pipeline",
        data=body,
        method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read() or b"{}")
    output = []
    for result in payload.get("results", [])[:len(statements)]:
        if result.get("type") != "ok":
            raise RuntimeError(result.get("error", {}).get("message", "Turso SQL request failed."))
        output.append(result.get("response", {}).get("result", {}))
    if len(output) != len(statements):
        raise RuntimeError("Turso returned an incomplete SQL response.")
    return output


def ensure_schema():
    turso_request([
        {
            "sql": """
                CREATE TABLE IF NOT EXISTS watchlist_items (
                    owner_id TEXT NOT NULL,
                    ticker TEXT NOT NULL,
                    added_at TEXT NOT NULL,
                    PRIMARY KEY (owner_id, ticker)
                )
            """,
            "want_rows": False,
        },
        {
            "sql": "CREATE INDEX IF NOT EXISTS watchlist_items_ticker_idx ON watchlist_items(ticker)",
            "want_rows": False,
        },
    ])


def watchlist_tickers():
    result = turso_request([{
        "sql": "SELECT ticker, MIN(added_at) AS first_added FROM watchlist_items GROUP BY ticker ORDER BY first_added ASC",
        "want_rows": True,
    }])[0]
    tickers = []
    for row in result.get("rows", []):
        if not row:
            continue
        ticker = row[0].get("value")
        if ticker and isinstance(ticker, str):
            tickers.append(ticker)
    return tickers


def recent_rapid_index():
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=RECENT_HOURS)).isoformat()
    encoded = urllib.parse.quote(cutoff, safe="")
    rows = supabase_request(
        "market_index?select=ticker,indexed_at"
        f"&period=eq.{PERIOD}&horizon=eq.{HORIZON}"
        "&indexer=eq.rapidIndex"
        f"&indexed_at=gte.{encoded}&limit=10000"
    )
    return {row["ticker"]: row.get("indexed_at") for row in rows or []}


def save_analysis(ticker, result):
    now = datetime.now(timezone.utc).isoformat()
    payload = {
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
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    request = urllib.request.Request(
        base + "/rest/v1/analysis_jobs",
        data=json.dumps(payload).encode(),
        method="POST",
        headers={
            "apikey": key,
            "Authorization": "Bearer " + key,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        rows = json.loads(response.read() or b"[]")
    if not rows:
        raise RuntimeError("Could not persist the WatchIndex analysis job.")
    upsert_market_index(rows[0]["id"], ticker, PERIOD, HORIZON, result, "rapidIndex")


def run_once(failed_until):
    tickers = watchlist_tickers()
    if not tickers:
        print("No watchlist tickers are currently saved.")
        return 0

    recent = recent_rapid_index()
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
    token = os.environ["GITHUB_TOKEN"]
    repository = os.environ["GITHUB_REPOSITORY"]
    ref = os.environ.get("GITHUB_REF_NAME", "main")
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/actions/workflows/watch-index.yml/dispatches",
        data=json.dumps({"ref": ref}).encode(),
        method="POST",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + token,
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30):
        pass
    print("Successor WatchIndex run dispatched.")


def main():
    required = ("TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
    missing = [key for key in required if not os.environ.get(key)]
    if missing:
        print("Missing WatchIndex secrets: " + ", ".join(missing), file=sys.stderr)
        return 1

    ensure_schema()
    started = time.monotonic()
    failed_until = {}
    print("WatchIndex worker started. It checks every watchlist and shares the RapidIndex cache.")
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
