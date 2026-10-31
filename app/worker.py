"""GitHub Actions worker: run yfinance analysis and persist the result in Supabase."""
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

from .analyzer import analyze_ticker


def update_job(job_id: str, payload: dict) -> None:
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    body = json.dumps({**payload, "updated_at": datetime.now(timezone.utc).isoformat()}).encode()
    request = urllib.request.Request(
        f"{base}/rest/v1/analysis_jobs?id=eq.{job_id}",
        data=body,
        method="PATCH",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status not in (200, 204):
            raise RuntimeError(f"Supabase update failed with HTTP {response.status}")


def main() -> int:
    job_id, ticker, period, horizon = sys.argv[1:5]
    try:
        update_job(job_id, {"status": "running", "error": None})
        result = analyze_ticker(ticker, period, int(horizon))
        update_job(job_id, {"status": "completed", "result": result, "error": None})
        print(f"Analysis completed for {ticker} ({job_id}).")
        return 0
    except Exception as exc:
        message = str(exc)[:500] or "Analysis failed."
        print(f"Analysis failed: {message}", file=sys.stderr)
        try:
            update_job(job_id, {"status": "failed", "error": message, "result": None})
        except Exception as update_error:
            print(f"Could not persist failure status: {update_error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
