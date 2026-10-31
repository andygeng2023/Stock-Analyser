"""Hourly cleanup for expired shared analysis and market-index cache rows."""
import json
import os
import urllib.request


def main():
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    request = urllib.request.Request(
        f"{base}/rest/v1/rpc/cleanup_expired_analysis_cache",
        data=b"{}",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "apikey": key,
            "Authorization": f"Bearer {key}",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.loads(response.read().decode("utf-8"))
    print("Expired cache cleanup:", result)


if __name__ == "__main__":
    main()
