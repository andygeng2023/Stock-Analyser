import unittest
import warnings
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import numpy as np
import pandas as pd

from app import analyzer, indexer


class ValidationAlignmentTests(unittest.TestCase):
    def test_surviving_feature_rows_keep_their_next_session_targets(self):
        feature_dates = pd.bdate_range("2026-01-05", periods=4)
        target_dates = pd.bdate_range("2026-01-06", periods=4)
        surviving_features = feature_dates[[0, 2, 3]]

        aligned = analyzer._aligned_target_dates(
            surviving_features,
            feature_dates,
            target_dates,
        )

        self.assertEqual(list(aligned), list(target_dates[[0, 2, 3]]))

    def test_unknown_feature_date_is_rejected(self):
        feature_dates = pd.bdate_range("2026-01-05", periods=2)
        target_dates = pd.bdate_range("2026-01-06", periods=2)
        unknown_date = pd.DatetimeIndex(["2026-02-01"])

        with self.assertRaises(analyzer.AnalysisError):
            analyzer._aligned_target_dates(unknown_date, feature_dates, target_dates)


class ArimaSelectionTests(unittest.TestCase):
    def test_prefers_converged_candidate_over_lower_aic_failed_fit(self):
        class Fit:
            def __init__(self, aic, converged):
                self.aic = aic
                self.mle_retvals = {"converged": converged}

        class FakeArima:
            def __init__(self, *args, order, **kwargs):
                self.order = order

            def fit(self):
                return {
                    (1, 0, 0): Fit(1.0, False),
                    (0, 0, 1): Fit(9.0, True),
                }[self.order]

        with patch.object(analyzer, "ORDERS", [(1, 0, 0), (0, 0, 1)]):
            with patch.object(analyzer, "ARIMA", FakeArima):
                order, fitted = analyzer._select_order(np.arange(50, dtype=float))

        self.assertEqual(order, (0, 0, 1))
        self.assertTrue(fitted.mle_retvals["converged"])

    def test_uses_best_finite_fallback_when_no_candidate_converges(self):
        class Fit:
            def __init__(self, aic):
                self.aic = aic
                self.mle_retvals = {"converged": False}

        class FakeArima:
            def __init__(self, *args, order, **kwargs):
                self.order = order

            def fit(self):
                return {
                    (1, 0, 0): Fit(12.0),
                    (0, 0, 1): Fit(8.0),
                }[self.order]

        with patch.object(analyzer, "ORDERS", [(1, 0, 0), (0, 0, 1)]):
            with patch.object(analyzer, "ARIMA", FakeArima):
                with warnings.catch_warnings(record=True) as caught:
                    warnings.simplefilter("always")
                    order, fitted = analyzer._select_order(np.arange(50, dtype=float))

        self.assertEqual(order, (0, 0, 1))
        self.assertFalse(fitted.mle_retvals["converged"])
        self.assertTrue(any("No ARIMA candidate converged" in str(w.message) for w in caught))


class IndexerCooldownTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)

    def test_retry_fields_are_independent_for_each_indexer(self):
        self.assertEqual(
            indexer._retry_fields("rapidIndex"),
            ("rapid_attempted_at", "rapid_retry_after", "rapid_last_error"),
        )
        self.assertEqual(
            indexer._retry_fields("SlowIndex"),
            ("slow_attempted_at", "slow_retry_after", "slow_last_error"),
        )

    def test_insufficient_history_gets_seven_day_cooldown(self):
        retry_at = indexer._retry_after_for_failure(
            "Insufficient price history. Check the ticker.",
            self.now,
        )
        self.assertEqual(retry_at, self.now + timedelta(days=7))

    def test_transient_network_failure_gets_short_cooldown(self):
        retry_at = indexer._retry_after_for_failure(
            "Yahoo request timed out",
            self.now,
        )
        self.assertEqual(retry_at, self.now + timedelta(minutes=30))

    def test_ticker_is_skipped_until_retry_time(self):
        row = {"rapid_retry_after": (self.now + timedelta(hours=2)).isoformat()}
        self.assertFalse(indexer._retry_is_available(row, "rapidIndex", self.now))
        self.assertTrue(
            indexer._retry_is_available(
                row,
                "rapidIndex",
                self.now + timedelta(hours=2),
            )
        )

    def test_invalid_cooldown_does_not_permanently_block_ticker(self):
        self.assertTrue(
            indexer._retry_is_available(
                {"rapid_retry_after": "not-a-date"},
                "rapidIndex",
                self.now,
            )
        )


if __name__ == "__main__":
    unittest.main()
