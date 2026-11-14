import unittest

from app.indexer import parse_index_shard


class IndexShardConfigTests(unittest.TestCase):
    def test_plain_shard_values(self):
        self.assertEqual(parse_index_shard("0"), 0)
        self.assertEqual(parse_index_shard("1"), 1)

    def test_legacy_escaped_matrix_values(self):
        self.assertEqual(parse_index_shard(r"\\0"), 0)
        self.assertEqual(parse_index_shard(r"\\1"), 1)

    def test_rejects_invalid_shard(self):
        for value in ("", "two", "2", "-1", "0\\"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_index_shard(value)


if __name__ == "__main__":
    unittest.main()
