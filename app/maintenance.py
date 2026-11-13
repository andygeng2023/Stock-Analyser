"""Cleanup expired Cloudflare D1 analysis and market-index cache rows."""
import json
import os
import urllib.request


def main():
    base = os.environ["CLOUDFLARE_API_URL"].rstrip("/")
    key = os.environ["CLOUDFLARE_ADMIN_API_TOKEN"]
    url = f"{base}/internal/rest/v1/rpc/cleanup_expired_analysis_cache"
    request = urllib.request.Request(
        url,
        data=json.dumps({}).encode(),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
        result = json.loads(raw) if raw else None
    print("Expired cache cleanup:", result)


if __name__ == "__main__":
    main()
