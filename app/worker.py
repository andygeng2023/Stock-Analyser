"""Long-lived GitHub Actions worker that drains the shared Supabase queue."""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from .analyzer import analyze_ticker
from .scanner import run_market_scan

POLL_SECONDS = 5
IDLE_TIMEOUT_SECONDS = 120
# GitHub's hosted-job hard limit is six hours. The workflow timeout is 350m;
# hand off at 345m to leave time for the dispatch request and graceful exit.
MAX_RUNTIME_SECONDS = 345 * 60


def request_json(url: str, *, method: str = "GET", payload=None, headers=None):
    body = None if payload is None else json.dumps(payload).encode()
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, data=body, method=method, headers=request_headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def supabase_request(path: str, *, method: str = "GET", payload=None):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return request_json(
        f"{base}/rest/v1/{path}",
        method=method,
        payload=payload,
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
    )


def update_job(job_id: str, payload: dict) -> None:
    payload = {**payload, "updated_at": datetime.now(timezone.utc).isoformat()}
    supabase_request(f"analysis_jobs?id=eq.{job_id}", method="PATCH", payload=payload)



def upsert_market_index(job_id: str, ticker: str, period: str, horizon: int, result: dict) -> None:
    fundamentals = result.get("fundamentals") or {}
    market_cap = fundamentals.get("market_cap") or fundamentals.get("marketCap")
    try:
        market_cap = float(market_cap) if market_cap is not None else None
    except (TypeError, ValueError):
        market_cap = None
    payload = {
        "ticker": ticker, "period": period, "horizon": horizon, "result": result,
        "source_job_id": job_id, "indexed_at": datetime.now(timezone.utc).isoformat(),
        "market_cap": market_cap,
        "priority": float(result.get("market_summary", {}).get("average_dollar_volume", 0) or 0),
    }
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    request_json(
        f"{base}/rest/v1/market_index?on_conflict=ticker,period,horizon",
        method="POST", payload=payload,
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Prefer": "resolution=merge-duplicates,return=minimal"},
    )


def claim_next_job():
    rows = supabase_request("rpc/claim_next_analysis_job", method="POST", payload={})
    return rows[0] if rows else None


def queue_has_pending_jobs() -> bool:
    rows = supabase_request("analysis_jobs?select=id&status=eq.queued&limit=1")
    return bool(rows)


def dispatch_successor() -> None:
    token = os.environ["GITHUB_TOKEN"]
    repository = os.environ["GITHUB_REPOSITORY"]
    ref = os.environ.get("GITHUB_REF_NAME", "main")
    url = f"https://api.github.com/repos/{repository}/actions/workflows/analyze-stock.yml/dispatches"
    request_json(
        url,
        method="POST",
        payload={"ref": ref},
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    print("Successor worker dispatched; GitHub concurrency will start it after this run exits.")


def process_job(job: dict) -> None:
    job_id = job["id"]
    ticker = job["ticker"]
    try:
        print(f"Starting {ticker} ({job_id}); attempt {job.get('attempts', 1)}.")
        def report_progress(value, stage, detail):
            update_job(job_id, {"progress": max(0, min(99, int(value))), "stage": f"{stage}: {detail}"})
        report_progress(1, "Starting", "Preparing the requested analysis.")
        if job.get("job_type") == "scan":
            result = run_market_scan(job.get("scan_source") or "both", progress_callback=report_progress)
        else:
            result = analyze_ticker(ticker, job["period"], int(job["horizon"]), progress_callback=report_progress)
        update_job(job_id, {"status": "completed", "result": result, "error": None, "progress": 100, "stage": "Complete"})
        if job.get("job_type") != "scan":
            try:
                upsert_market_index(job_id, ticker, job["period"], int(job["horizon"]), result)
            except Exception as index_error:
                print(f"Could not update market index for {ticker}: {index_error}", file=sys.stderr)
        print(f"Analysis completed for {ticker} ({job_id}).")
    except Exception as exc:
        message = str(exc)[:500] or "Analysis failed."
        print(f"Analysis failed for {ticker} ({job_id}): {message}", file=sys.stderr)
        try:
            update_job(job_id, {"status": "failed", "error": message, "result": None, "stage": "Failed"})
        except Exception as update_error:
            print(f"Could not persist failure status: {update_error}", file=sys.stderr)


def main() -> int:
    started_at = time.monotonic()
    last_work_at = started_at
    completed = 0
    print("Stock Analyser queue worker started.")

    while True:
        elapsed = time.monotonic() - started_at
        if elapsed >= MAX_RUNTIME_SECONDS:
            try:
                if queue_has_pending_jobs():
                    dispatch_successor()
                else:
                    print("Runtime hand-off reached with an empty queue; no successor needed.")
                return 0
            except Exception as exc:
                print(f"Could not hand off to successor worker: {exc}", file=sys.stderr)
                return 1

        try:
            job = claim_next_job()
        except Exception as exc:
            print(f"Queue poll failed: {exc}", file=sys.stderr)
            time.sleep(POLL_SECONDS)
            continue

        if job:
            last_work_at = time.monotonic()
            process_job(job)
            completed += 1
            continue

        idle_for = time.monotonic() - last_work_at
        if idle_for >= IDLE_TIMEOUT_SECONDS:
            print(f"Queue idle for {IDLE_TIMEOUT_SECONDS}s; stopping after {completed} analyses.")
            return 0
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
