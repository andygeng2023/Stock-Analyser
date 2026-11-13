import sqlite3
import unittest
from pathlib import Path


class CloudflareD1SchemaTests(unittest.TestCase):
    def test_schema_builds_in_sqlite_and_contains_runtime_tables(self):
        schema = Path("cloudflare/schema.sql").read_text(encoding="utf-8")
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(schema)
            tables = {
                row[0] for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            self.assertTrue({
                "analysis_jobs", "market_index", "market_index_catalog",
                "users", "sessions", "watchlist_items",
            }.issubset(tables))
            columns = {
                row[1] for row in connection.execute("PRAGMA table_info(analysis_jobs)")
            }
            self.assertTrue({"id", "ticker", "result", "progress", "stage"}.issubset(columns))
            indexes = {
                row[1] for row in connection.execute("PRAGMA index_list(market_index)")
            }
            self.assertTrue(any("lookup" in name for name in indexes))
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
