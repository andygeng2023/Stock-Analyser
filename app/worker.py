"""Analysis queue worker using TiDB directly."""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

from .analyzer import analyze_ticker
from .db import connect, fetch_one, update_one, upsert_one
from .scanner import run_market_scan

POLL_SECONDS = 5
IDLE_TIMEOUT_SECONDS = 120
MAX_RUNTIME_SECONDS = 345 * 60


def request_json(url, *, method="GET", payload=None, headers=None):
    body = None if payload is None else json.dumps(payload).encode()
    h = {"Content-Type": "application/json", "User-Agent": "StockAnalyser-Worker/1.0"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def update_job(job_id, payload):
    update_one("analysis_jobs", "id", job_id,
               {**payload, "updated_at": datetime.now(timezone.utc).isoformat()})


def upsert_market_index(job_id, ticker, period, horizon, result, indexer):
    fundamentals = result.get("fundamentals") or {}
    cap = fundamentals.get("market_cap") or fundamentals.get("marketCap")
    try:
        cap = float(cap) if cap is not None else None
    except (TypeError, ValueError):
        cap = None
    indexed_at = datetime.now(timezone.utc).isoformat()
    summary = result.get("market_summary") or {}
    upsert_one("market_index", {
        "ticker": ticker, "period": period, "horizon": horizon, "indexer": indexer,
        "result": result, "source_job_id": job_id, "indexed_at": indexed_at,
        "market_cap": cap,
        "priority": float(summary.get("average_dollar_volume", 0) or 0),
    }, ("ticker", "period", "horizon", "indexer"))
    upsert_one("market_index_catalog", {
        "ticker": ticker, "market_cap": cap,
        "priority": float(summary.get("average_dollar_volume", 0) or 0),
        ("last_slow_indexed_at" if indexer == "SlowIndex" else "last_indexed_at"): indexed_at,
        "updated_at": indexed_at,
    }, ("ticker",))


def claim_next_job():
    """Claim one job transactionally; row locking prevents duplicate workers."""
    now = datetime.now(timezone.utc).isoformat()
    stale = (datetime.now(timezone.utc) - timedelta(minutes=90)).isoformat()
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""UPDATE analysis_jobs SET status='queued',
                       error='Recovered after an interrupted worker.',updated_at=%s
                       WHERE status='running' AND updated_at<%s AND attempts<3""", (now, stale))
        cur.execute("""UPDATE analysis_jobs SET status='failed',
                       error='Worker stopped repeatedly before completing this analysis.',updated_at=%s
                       WHERE status='running' AND updated_at<%s AND attempts>=3""", (now, stale))
        cur.execute("""SELECT id FROM analysis_jobs WHERE status='queued'
                       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED""")
        selected = cur.fetchone()
        if not selected:
            return None
        cur.execute("""UPDATE analysis_jobs SET status='running',attempts=attempts+1,
                       error=NULL,updated_at=%s WHERE id=%s
                       RETURNING id,ticker,period,horizon,job_type,scan_source,save_to_indexer,
                                 status,attempts,progress,stage,created_at,updated_at""",
                    (now, selected["id"]))
        return cur.fetchone()


def queue_has_pending_jobs():
    return bool(fetch_one("SELECT id FROM analysis_jobs WHERE status='queued' LIMIT 1"))


def dispatch_successor():
    token = os.environ["GITHUB_TOKEN"]
    repo = os.environ["GITHUB_REPOSITORY"]
    ref = os.environ.get("GITHUB_REF_NAME", "main")
    request_json(f"https://api.github.com/repos/{repo}/actions/workflows/analyze-stock.yml/dispatches",
                 method="POST", payload={"ref": ref},
                 headers={"Accept": "application/vnd.github+json",
                          "Authorization": f"Bearer {token}",
                          "X-GitHub-Api-Version": "2022-11-28"})


def process_job(job):
    job_id, ticker = job["id"], job["ticker"]
    try:
        def progress(value, stage, detail):
            update_job(job_id, {"progress": max(0, min(99, int(value))),
                                "stage": f"{stage}: {detail}"})
        progress(1, "Starting", "Preparing the requested analysis.")
        if job.get("job_type") == "scan":
            result = run_market_scan(job.get("scan_source") or "both", progress_callback=progress)
        else:
            result = analyze_ticker(ticker, job["period"], int(job["horizon"]),
                                    progress_callback=progress)
        update_job(job_id, {"status": "completed", "result": result, "error": None,
                            "progress": 100, "stage": "Complete"})
        if job.get("job_type") != "scan" and job.get("save_to_indexer", "rapidIndex") != "none":
            try:
                upsert_market_index(job_id, ticker, job["period"], int(job["horizon"]),
                                    result, job.get("save_to_indexer") or "rapidIndex")
            except Exception as exc:
                print(f"Index cache update failed for {ticker}: {exc}", file=sys.stderr)
    except Exception as exc:
        try:
            update_job(job_id, {"status": "failed", "error": str(exc)[:500],
                                "result": None, "stage": "Failed"})
        except Exception as save_error:
            print(f"Could not persist failure: {save_error}", file=sys.stderr)
        print(f"Analysis failed for {ticker}: {exc}", file=sys.stderr)


def main():
    if not os.environ.get("DATABASE_URL"):
        raise RuntimeError("DATABASE_URL is missing.")
    started, last_work, completed = time.monotonic(), time.monotonic(), 0
    print("TiDB analysis queue worker started.")
    while True:
        if time.monotonic() - started >= MAX_RUNTIME_SECONDS:
            if queue_has_pending_jobs():
                dispatch_successor()
            return 0
        try:
            job = claim_next_job()
        except Exception as exc:
            print(f"TiDB queue poll failed: {exc}", file=sys.stderr)
            time.sleep(POLL_SECONDS)
            continue
        if job:
            last_work = time.monotonic()
            process_job(job)
            completed += 1
        elif time.monotonic() - last_work >= IDLE_TIMEOUT_SECONDS:
            print(f"Queue idle; completed {completed} jobs.")
            return 0
        else:
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
