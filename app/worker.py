"""Long-lived GitHub Actions worker that drains the shared Supabase queue."""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from .analyzer import analyze_ticker

POLL_SECONDS = 5
IDLE_TIMEOUT_SECONDS = 120
MAX_RUNTIME_SECONDS = 345 * 60  # Leave a five-minute margin under the 350-minute job timeout.


def supabase_request(path: str, *, method: str = "GET", payload=None):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"{base}/rest/v1/{path}",
        data=body,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def update_job(job_id: str, payload: dict) -> None:
    payload = {**payload, "updated_at": datetime.now(timezone.utc).isoformat()}
    supabase_request(
        f"analysis_jobs?id=eq.{job_id}",
        method="PATCH",
        payload=payload,
    )


def claim_next_job():
    rows = supabase_request("rpc/claim_next_analysis_job", method="POST", payload={})
    if not rows:
        return None
    return rows[0]


def process_job(job: dict) -> None:
    job_id = job["id"]
    ticker = job["ticker"]
    try:
        print(f"Starting {ticker} ({job_id}); attempt {job.get('attempts', 1)}.")
        result = analyze_ticker(ticker, job["period"], int(job["horizon"]))
        update_job(job_id, {"status": "completed", "result": result, "error": None})
        print(f"Analysis completed for {ticker} ({job_id}).")
    except Exception as exc:
        message = str(exc)[:500] or "Analysis failed."
        print(f"Analysis failed for {ticker} ({job_id}): {message}", file=sys.stderr)
        try:
            update_job(job_id, {"status": "failed", "error": message, "result": None})
        except Exception as update_error:
            print(f"Could not persist failure status: {update_error}", file=sys.stderr)


def main() -> int:
    started_at = time.monotonic()
    last_work_at = started_at
    completed = 0
    print("Stock Analyser queue worker started.")

    while time.monotonic() - started_at < MAX_RUNTIME_SECONDS:
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

    print(f"Worker reached its safe runtime limit after {completed} analyses.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
