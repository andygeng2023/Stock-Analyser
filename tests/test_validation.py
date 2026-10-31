import unittest
from app.analyzer import analyze_ticker
from app.errors import AnalysisError

class AnalyzerInputTests(unittest.TestCase):
    def test_rejects_empty_ticker(self):
        with self.assertRaises(AnalysisError):
            analyze_ticker("")

    def test_rejects_whitespace_in_ticker(self):
        with self.assertRaises(AnalysisError):
            analyze_ticker("BRK B")

    def test_rejects_unsupported_period(self):
        with self.assertRaises(AnalysisError):
            analyze_ticker("AAPL", period="3mo")

    def test_rejects_horizon_below_range(self):
        with self.assertRaises(AnalysisError):
            analyze_ticker("AAPL", horizon=0)

    def test_rejects_horizon_above_range(self):
        with self.assertRaises(AnalysisError):
            analyze_ticker("AAPL", horizon=61)

if __name__ == "__main__":
    unittest.main()
