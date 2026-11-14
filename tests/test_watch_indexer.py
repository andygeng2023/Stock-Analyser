import unittest
from unittest.mock import patch
from app import watch_indexer


class WatchIndexerTests(unittest.TestCase):
    @patch("app.watch_indexer.fetch_all")
    def test_watchlist_reads_unique_tickers_directly(self, fetch_all):
        fetch_all.return_value = [{"ticker": "AAPL"}, {"ticker": "MSFT"}]
        self.assertEqual(watch_indexer.watchlist_tickers(), ["AAPL", "MSFT"])
        self.assertIn("SELECT DISTINCT ticker FROM watchlist_items", fetch_all.call_args.args[0])

    @patch("app.watch_indexer.fetch_all")
    def test_recent_index_only_uses_rapidindex(self, fetch_all):
        fetch_all.return_value = [{"ticker": "AAPL", "indexed_at": "2026-11-01T00:00:00+00:00"}]
        result = watch_indexer.recent_rapid_index(["AAPL"])
        query, params = fetch_all.call_args.args
        self.assertIn("indexer=%s", query)
        self.assertEqual(params[1:4], ("5y", 30, "rapidIndex"))
        self.assertEqual(set(result), {"AAPL"})


if __name__ == "__main__":
    unittest.main()
