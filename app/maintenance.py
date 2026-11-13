"""Cleanup expired Cloudflare D1 analysis and market-index cache rows."""
import os
from .worker import request_json


def main():
    base = os.environ["CLOUDFLARE_API_URL"].rstrip("/")
    key = os.environ["CLOUDFLARE_ADMIN_API_TOKEN"]
    result = request_json(
        f"{base}/internal/rest/v1/rpc/cleanup_expired_analysis_cache",
        method="POST",
        payload={},
        headers={"Authorization": f"Bearer {key}"},
    )
    print("Expired cache cleanup:", result)


if __name__ == "__main__":
    main()
