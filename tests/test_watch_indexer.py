import json
import os
import unittest
from unittest.mock import patch

from app import watch_indexer


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.body).encode()


class WatchIndexerTests(unittest.TestCase):
    @patch.dict(os.environ, {
        "TURSO_DATABASE_URL": "libsql://watchlist-example.turso.io",
        "TURSO_AUTH_TOKEN": "test-token",
    })
    @patch("app.watch_indexer.urllib.request.urlopen")
    def test_turso_request_uses_sql_over_http_and_bound_arguments(self, urlopen):
        urlopen.return_value = FakeResponse({
            "results": [{
                "type": "ok",
                "response": {
                    "type": "execute",
                    "result": {
                        "cols": [{"name": "ticker"}],
                        "rows": [[{"type": "text", "value": "AAPL"}]],
                    },
                },
            }, {"type": "ok", "response": {"type": "close"}}],
        })

        result = watch_indexer.turso_request([{
            "sql": "SELECT ticker FROM watchlist_items WHERE owner_id = ?",
            "args": ["profile-id"],
            "want_rows": True,
        }])

        request = urlopen.call_args.args[0]
        payload = json.loads(request.data)
        self.assertEqual(request.full_url, "https://watchlist-example.turso.io/v3/pipeline")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
        self.assertEqual(payload["requests"][0]["stmt"]["args"], [
            {"type": "text", "value": "profile-id"},
        ])
        self.assertEqual(result[0]["rows"][0][0]["value"], "AAPL")

    @patch("app.watch_indexer.turso_request")
    def test_watchlist_tickers_deduplicates_rows_returned_by_sql(self, turso_request):
        turso_request.return_value = [{
            "rows": [
                [{"type": "text", "value": "AAPL"}, {"type": "text", "value": "2026-01-01"}],
                [{"type": "text", "value": "MSFT"}, {"type": "text", "value": "2026-01-02"}],
            ],
        }]
        self.assertEqual(watch_indexer.watchlist_tickers(), ["AAPL", "MSFT"])
        self.assertIn("GROUP BY ticker", turso_request.call_args.args[0][0]["sql"])

    @patch("app.watch_indexer.supabase_request")
    def test_recent_index_lookup_is_limited_to_rapidindex_cache(self, supabase_request):
        supabase_request.return_value = [{"ticker": "AAPL", "indexed_at": "2026-11-01T00:00:00+00:00"}]
        result = watch_indexer.recent_rapid_index()
        query = supabase_request.call_args.args[0]
        self.assertIn("period=eq.5y", query)
        self.assertIn("horizon=eq.30", query)
        self.assertIn("indexer=eq.rapidIndex", query)
        self.assertEqual(set(result), {"AAPL"})


if __name__ == "__main__":
    unittest.main()
