import unittest
from unittest.mock import patch

from app import watch_indexer


class WatchIndexerTests(unittest.TestCase):
    @patch("app.watch_indexer.supabase_request")
    def test_watchlist_tickers_reads_all_pages_and_deduplicates(self, supabase_request):
        supabase_request.side_effect = [
            [{"ticker": "AAPL"}, {"ticker": "MSFT"}],
            [{"ticker": "AAPL"}, {"ticker": "NVDA"}],
            [],
        ]
        self.assertEqual(watch_indexer.watchlist_tickers(), ["AAPL", "MSFT", "NVDA"])
        self.assertEqual(supabase_request.call_count, 3)
        self.assertIn("watchlist_items?select=ticker", supabase_request.call_args_list[0].args[0])
        self.assertIn("offset=1000", supabase_request.call_args_list[1].args[0])

    @patch("app.watch_indexer.supabase_request")
    def test_recent_index_lookup_only_uses_rapidindex(self, supabase_request):
        supabase_request.return_value = [
            {"ticker": "AAPL", "indexed_at": "2026-11-01T00:00:00+00:00"},
        ]
        result = watch_indexer.recent_rapid_index()
        query = supabase_request.call_args.args[0]
        self.assertIn("period=eq.5y", query)
        self.assertIn("horizon=eq.30", query)
        self.assertIn("indexer=eq.rapidIndex", query)
        self.assertIn("indexed_at=gte.", query)
        self.assertEqual(set(result), {"AAPL"})

    @patch("app.watch_indexer.upsert_market_index")
    @patch("app.watch_indexer.supabase_request")
    def test_save_analysis_persists_job_then_updates_shared_cache(self, supabase_request, upsert):
        watch_indexer.save_analysis("AAPL", {"ticker": "AAPL", "forecast": {}})
        payload = supabase_request.call_args.kwargs["payload"]
        self.assertEqual(supabase_request.call_args.args[0], "analysis_jobs")
        self.assertEqual(payload["ticker"], "AAPL")
        self.assertEqual(payload["save_to_indexer"], "rapidIndex")
        self.assertEqual(payload["status"], "completed")
        upsert.assert_called_once()
        self.assertEqual(upsert.call_args.args[0], payload["id"])
        self.assertEqual(upsert.call_args.args[-1], "rapidIndex")


if __name__ == "__main__":
    unittest.main()
