"""Continuously refresh the shared market scan in the background."""
import os
import sys
import time
from datetime import datetime, timezone

from .scanner import run_market_scan
from .worker import request_json

MAX_RUNTIME_SECONDS = 345 * 60
SCAN_PERIOD = "5y"
SCAN_HORIZON = 30


def save_scan(result):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    now = datetime.now(timezone.utc).isoformat()
    payload = {
        "ticker": "SCAN",
        "period": SCAN_PERIOD,
        "horizon": SCAN_HORIZON,
        "job_type": "scan",
        "scan_source": "both",
        "status": "completed",
        "result": result,
        "error": None,
        "client_ip_hash": "background-market-scanner",
        "attempts": 1,
        "progress": 100,
        "stage": "Background market scan completed",
        "created_at": now,
        "updated_at": now,
    }
    rows = request_json(
        f"{base}/rest/v1/analysis_jobs",
        method="POST",
        payload=payload,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Prefer": "return=representation",
        },
    )
    print(f"Published background scan {rows[0]['id']} with {len(result.get('results') or [])} results.")


def dispatch_successor():
    token = os.environ["GITHUB_TOKEN"]
    repository = os.environ["GITHUB_REPOSITORY"]
    ref = os.environ.get("GITHUB_REF_NAME", "main")
    request_json(
        f"https://api.github.com/repos/{repository}/actions/workflows/scan-market.yml/dispatches",
        method="POST",
        payload={"ref": ref},
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    print("Successor background scanner dispatched; workflow concurrency will hand it off after this run.")


def main():
    started = time.monotonic()
    scans = 0
    while time.monotonic() - started < MAX_RUNTIME_SECONDS:
        print(f"Starting background scan cycle {scans + 1}.")
        result = run_market_scan("both")
        save_scan(result)
        scans += 1
        print(f"Background scan cycle {scans} completed.")
    print("Approaching the hosted-job runtime ceiling; handing scanning to a successor workflow.")
    dispatch_successor()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
