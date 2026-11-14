import unittest

from app.scanner import _parse_symbol_directory


class NasdaqSymbolDirectoryTests(unittest.TestCase):
    def test_nasdaq_listed_filters_test_issues_and_etfs(self):
        payload = """Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF
AAPL|Apple Inc. - Common Stock|Q|N|N|100|N
SPY|SPDR S&P 500 ETF|G|N|N|100|Y
FAKE|Test Security|G|Y|N|100|N
XYZ|Example Mutual Fund|G|N|N|100|N
File Creation Time: 111420262100||||||
"""
        self.assertEqual(_parse_symbol_directory(payload), {"AAPL"})

    def test_other_listed_uses_cqs_symbol_and_normalizes_class_shares(self):
        payload = """ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
BRK B|Berkshire Hathaway Inc. Class B|N|BRK.B|N|100|N|BRK.B
SPY|SPDR S&P 500 ETF|P|SPY|Y|100|N|SPY
FAKE|Test Security|N|FAKE|N|100|Y|FAKE
"""
        self.assertEqual(_parse_symbol_directory(payload, other_listed=True), {"BRK-B"})


if __name__ == "__main__":
    unittest.main()
