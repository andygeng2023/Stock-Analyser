"""Remove expired analysis and market-index cache rows directly in TiDB."""
from datetime import datetime, timedelta, timezone
from .db import connect, verify_database


def main():
    print("Database preflight:", verify_database())
    now = datetime.now(timezone.utc)
    short_cache_cutoff = (now - timedelta(hours=8)).isoformat()
    legacy_cutoff = (now - timedelta(days=30)).isoformat()
    rate_limit_cutoff = int(now.timestamp() * 1000) - 86400000
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""DELETE FROM market_index
                       WHERE (indexer IN ('previewIndex','FullIndex') AND indexed_at<%s)
                          OR (indexer NOT IN ('previewIndex','FullIndex') AND indexed_at<%s)""",
                    (short_cache_cutoff, legacy_cutoff))
        index_rows = cur.rowcount
        cur.execute("""DELETE FROM analysis_jobs WHERE status='completed'
                       AND ((save_to_indexer IN ('previewIndex','FullIndex','none') AND created_at<%s)
                         OR (save_to_indexer NOT IN ('previewIndex','FullIndex','none') AND created_at<%s))""",
                    (short_cache_cutoff, legacy_cutoff))
        job_rows = cur.rowcount
        cur.execute("DELETE FROM api_rate_limits WHERE window_start<%s", (rate_limit_cutoff,))
        rate_rows = cur.rowcount
    print({"expired_index_rows": index_rows, "expired_completed_jobs": job_rows,
           "expired_rate_limits": rate_rows})


if __name__ == "__main__":
    main()
