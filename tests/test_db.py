import unittest

from app.db import normalize_dsn


class TiDBConnectionStringTests(unittest.TestCase):
    def test_normalizes_ti_db_cli_conninfo_and_placeholder(self):
        value = "psql 'host=db.example port=5432 user=app dbname=<DB>; sslmode=verify-full'"
        result = normalize_dsn(value)
        self.assertTrue(result.startswith("host=db.example"))
        self.assertIn("dbname=postgres", result)
        self.assertIn("sslmode=verify-full", result)
        self.assertNotIn("<DB>", result)

    def test_normalizes_backslash_prefixed_console_command(self):
        value = r"\psql 'host=db.example port=5432 user=app dbname=<DB>; sslmode=verify-full'"
        result = normalize_dsn(value)
        self.assertTrue(result.startswith("host=db.example"))
        self.assertIn("dbname=postgres", result)

    def test_preserves_explicit_database_name(self):
        value = "host=db.example port=5432 user=app dbname=stock_analyser sslmode=verify-full"
        self.assertEqual(normalize_dsn(value), value)

    def test_accepts_plain_postgresql_uri(self):
        value = "postgresql://app:secret@db.example:5432/postgres?sslmode=verify-full"
        self.assertEqual(normalize_dsn(value), value)

    def test_rejects_empty_connection_string(self):
        with self.assertRaises(RuntimeError):
            normalize_dsn("")


if __name__ == "__main__":
    unittest.main()
