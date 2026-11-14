"""Cleanup expired TiDB analysis and market-index cache rows."""
import json
import os
import urllib.error
import urllib.request


def main():
    base = os.environ["STOCK_ANALYSER_API_URL"].rstrip("/")
    key = os.environ["ADMIN_API_TOKEN"]
    url = f"{base}/api/internal/rest/v1/rpc/cleanup_expired_analysis_cache"
    request = urllib.request.Request(
        url,
        data=json.dumps({}).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "StockAnalyser-Worker/1.0",
            "Authorization": f"Bearer {key}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"Stock Analyser API returned HTTP {exc.code}: {detail}") from exc
    result = json.loads(raw) if raw else None
    print("Expired cache cleanup:", result)


if __name__ == "__main__":
    main()
