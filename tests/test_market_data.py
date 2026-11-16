import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from app import market_data


def _history(rows=120, start="2025-01-01"):
    dates = pd.bdate_range(start, periods=rows)
    close = np.linspace(100.0, 120.0, rows)
    return pd.DataFrame(
        {
            "Open": close - 0.2,
            "High": close + 0.5,
            "Low": close - 0.5,
            "Close": close,
            "Volume": np.full(rows, 50000.0),
        },
        index=dates,
    )


class FakeYahooQueryTicker:
    def __init__(self, ticker, asynchronous=False):
        self.ticker = ticker
        self.asynchronous = asynchronous
        self.history_calls = []

    def history(self, **kwargs):
        self.history_calls.append(kwargs)
        return self.history_frame

    @property
    def price(self):
        return {
            "AAPL": {
                "longName": "Apple Inc.",
                "exchangeName": "NMS",
                "currency": "USD",
                "marketCap": 3_000_000_000_000,
            }
        }

    @property
    def summary_detail(self):
        return {"AAPL": {"trailingPE": 30.0, "forwardPE": 28.0, "dividendYield": 0.005}}

    @property
    def key_stats(self):
        return {"AAPL": {"trailingEps": 6.0}}

    @property
    def financial_data(self):
        return {"AAPL": {"totalRevenue": 400_000_000_000, "profitMargins": 0.25}}

    @property
    def asset_profile(self):
        return {"AAPL": {"sector": "Technology", "industry": "Consumer Electronics"}}


class MarketDataFallbackTests(unittest.TestCase):
    def test_yfinance_is_primary_when_history_is_valid(self):
        class FakeAsset:
            def history(self, **kwargs):
                self.kwargs = kwargs
                return _history()

        with patch.object(market_data.yf, "Ticker", return_value=FakeAsset()), patch.object(
            market_data, "new_yahooquery_ticker"
        ) as secondary:
            history, query_asset, metadata = market_data.fetch_history("AAPL", "5y")

        self.assertEqual(len(history), 120)
        self.assertEqual(metadata["history_provider"], "yfinance")
        self.assertFalse(metadata["history_fallback_used"])
        self.assertIsNone(query_asset)
        secondary.assert_not_called()

    def test_yahooquery_is_used_when_yfinance_history_is_insufficient(self):
        class FakeAsset:
            def history(self, **kwargs):
                return _history(rows=12)

        query = FakeYahooQueryTicker("AAPL")
        query.history_frame = pd.concat(
            {"AAPL": _history()},
            names=["symbol", "date"],
        )

        with patch.object(market_data, "new_yahooquery_ticker", return_value=query):
            history, returned_query, metadata = market_data.fetch_history(
                "AAPL", "5y", yfinance_asset=FakeAsset()
            )

        self.assertEqual(len(history), 120)
        self.assertIs(returned_query, query)
        self.assertEqual(metadata["history_provider"], "yahooquery")
        self.assertTrue(metadata["history_fallback_used"])
        self.assertEqual(query.history_calls[0]["adj_ohlc"], True)
        self.assertIn("yfinance returned insufficient", metadata["history_fallback_reason"])

    def test_yahooquery_history_is_normalised_to_daily_ohlcv(self):
        raw = pd.concat(
            {"AAPL": _history().rename(columns=str.lower)},
            names=["symbol", "date"],
        )
        normalised = market_data.normalise_history(raw, "AAPL")

        self.assertEqual(list(normalised.index), list(_history().index))
        self.assertIn("Close", normalised.columns)
        self.assertIn("Volume", normalised.columns)
        self.assertTrue(np.isfinite(normalised["Close"]).all())

    def test_company_info_is_enriched_from_yahooquery(self):
        class FakeAsset:
            def get_info(self):
                return {"longName": "Apple Inc."}

        query = FakeYahooQueryTicker("AAPL")
        info, provider, returned_query = market_data.fetch_company_info(
            FakeAsset(), "AAPL", yahooquery_asset=query
        )

        self.assertEqual(info["longName"], "Apple Inc.")
        self.assertEqual(info["exchange"], "NMS")
        self.assertEqual(info["currency"], "USD")
        self.assertEqual(info["trailingPE"], 30.0)
        self.assertEqual(info["totalRevenue"], 400_000_000_000)
        self.assertEqual(info["sector"], "Technology")
        self.assertEqual(provider, "yfinance+yahooquery")
        self.assertIs(returned_query, query)


if __name__ == "__main__":
    unittest.main()
