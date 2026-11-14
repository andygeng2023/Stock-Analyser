import unittest
from unittest.mock import patch

from app import worker


class WorkerIndexMetadataTests(unittest.TestCase):
    @patch("app.worker.upsert_one")
    @patch("app.worker.fetch_one")
    def test_missing_analysis_metadata_preserves_existing_index_values(self, fetch_one, upsert_one):
        previous = {
            "market_cap": 12_000_000_000,
            "avg_dollar_volume": 45_000_000,
            "priority": 45_000_000,
        }
        fetch_one.side_effect = [previous, previous]

        worker.upsert_market_index(
            "job-1", "MSFT", "5y", 30,
            {"fundamentals": {}, "market_summary": {}},
            "rapidIndex",
        )

        self.assertEqual(fetch_one.call_count, 2)
        market_row = upsert_one.call_args_list[0].args[1]
        catalog_row = upsert_one.call_args_list[1].args[1]
        for row in (market_row, catalog_row):
            self.assertEqual(row["market_cap"], 12_000_000_000)
            self.assertEqual(row["avg_dollar_volume"], 45_000_000)
            self.assertEqual(row["priority"], 45_000_000)

    @patch("app.worker.upsert_one")
    @patch("app.worker.fetch_one")
    def test_new_analysis_metadata_replaces_old_values(self, fetch_one, upsert_one):
        previous = {
            "market_cap": 10_000_000_000,
            "avg_dollar_volume": 30_000_000,
            "priority": 30_000_000,
        }
        fetch_one.side_effect = [previous, previous]

        worker.upsert_market_index(
            "job-2", "MSFT", "5y", 30,
            {
                "fundamentals": {"market_cap": 15_000_000_000},
                "market_summary": {"average_dollar_volume": 60_000_000},
            },
            "rapidIndex",
        )

        market_row = upsert_one.call_args_list[0].args[1]
        catalog_row = upsert_one.call_args_list[1].args[1]
        for row in (market_row, catalog_row):
            self.assertEqual(row["market_cap"], 15_000_000_000)
            self.assertEqual(row["avg_dollar_volume"], 60_000_000)
            self.assertEqual(row["priority"], 60_000_000)

    @patch("app.worker.update_job")
    @patch("app.worker.upsert_market_index")
    @patch("app.worker.analyze_ticker")
    def test_job_is_not_marked_complete_before_index_write(self, analyze, index, update):
        events = []
        analyze.return_value = {"ticker": "MSFT"}
        index.side_effect = lambda *args, **kwargs: events.append("indexed")
        update.side_effect = lambda job_id, payload: events.append(payload["status"])

        worker.process_job({
            "id": "job-3",
            "ticker": "MSFT",
            "period": "5y",
            "horizon": 30,
            "job_type": "analysis",
            "save_to_indexer": "rapidIndex",
        })

        self.assertEqual(events, ["indexed", "completed"])


if __name__ == "__main__":
    unittest.main()
