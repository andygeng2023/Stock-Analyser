"""Continuous background scanner writing completed scans directly to TiDB."""
import os
import sys
import time
import threading
import uuid
from datetime import datetime, timezone

from .db import insert_one, verify_database
from .scanner import run_market_scan
from .worker import request_json

MAX_RUNTIME_SECONDS = 345 * 60


def save_scan(result):
    now = datetime.now(timezone.utc).isoformat()
    row = insert_one("analysis_jobs", {
        "id": str(uuid.uuid4()), "ticker": "SCAN", "period": "5y", "horizon": 30,
        "job_type": "scan", "scan_source": "both", "save_to_indexer": "none",
        "status": "completed", "result": result, "error": None,
        "client_ip_hash": "background-market-scanner", "attempts": 1,
        "progress": 100, "stage": "Background market scan completed",
        "created_at": now, "updated_at": now,
    })
    print(f"Published background scan {row['id']} with {len(result.get('results') or [])} results.")


def dispatch_successor():
    request_json(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}/actions/workflows/scan-market.yml/dispatches",
        method="POST", payload={"ref": os.environ.get("GITHUB_REF_NAME", "main")},
        headers={"Accept": "application/vnd.github+json",
                 "Authorization": "Bearer " + os.environ["GITHUB_TOKEN"],
                 "X-GitHub-Api-Version": "2022-11-28"},
    )


def handoff():
    time.sleep(340 * 60)
    try:
        dispatch_successor()
    except Exception as exc:
        print(f"Background scanner hand-off failed: {exc}", file=sys.stderr)


def main():
    if not os.environ.get("DATABASE_URL") or not os.environ.get("GITHUB_TOKEN"):
        raise RuntimeError("DATABASE_URL and GITHUB_TOKEN are required.")
    print("Database preflight:", verify_database())
    threading.Thread(target=handoff, daemon=True).start()
    started = time.monotonic()
    while time.monotonic() - started < MAX_RUNTIME_SECONDS:
        try:
            result = run_market_scan("both")
            save_scan(result)
        except Exception as exc:
            print(f"Background scan failed: {str(exc)[:300]}", file=sys.stderr)
            time.sleep(60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
