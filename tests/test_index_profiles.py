import unittest

from app.ensemble import build_regressors
from app.indexer import INDEXER_SETTINGS, _retry_is_available
from app.training import _merge_prior, _update_global_profile


class IndexProfileTests(unittest.TestCase):
    def test_indexer_profiles_use_separate_history_and_cadence(self):
        self.assertEqual(INDEXER_SETTINGS["previewIndex"]["period"], "5y")
        self.assertEqual(INDEXER_SETTINGS["FullIndex"]["period"], "10y")
        self.assertEqual(INDEXER_SETTINGS["previewIndex"]["horizon"], 30)
        self.assertEqual(INDEXER_SETTINGS["FullIndex"]["horizon"], 30)
        self.assertLess(
            INDEXER_SETTINGS["FullIndex"]["batch_limit"],
            INDEXER_SETTINGS["previewIndex"]["batch_limit"],
        )

    def test_retry_cooldowns_are_profile_specific(self):
        self.assertTrue(_retry_is_available({}, "previewIndex"))
        self.assertTrue(_retry_is_available({}, "FullIndex"))
        self.assertFalse(_retry_is_available(
            {"preview_retry_after": "2099-01-01T00:00:00+00:00"},
            "previewIndex",
        ))
        self.assertFalse(_retry_is_available(
            {"full_retry_after": "2099-01-01T00:00:00+00:00"},
            "FullIndex",
        ))

    def test_full_profile_has_more_model_families(self):
        preview = build_regressors("preview")
        full = build_regressors("full")
        self.assertEqual(len(preview), 10)
        self.assertEqual(len(full), 16)
        self.assertTrue(set(preview).issubset(full))

    def test_shared_learning_prior_blends_ticker_and_global_scores(self):
        merged = _merge_prior(
            {"analyses_seen": 4, "models": {"ridge": {"score": 0.5}}},
            {"analyses_seen": 30, "models": {"ridge": {"score": 0.9}}},
        )
        self.assertAlmostEqual(merged["models"]["ridge"]["score"], 0.76)
        self.assertEqual(merged["global_analyses_seen"], 30)

    def test_global_learning_uses_new_holdout_metrics(self):
        updated = _update_global_profile(
            "previewIndex",
            {"as_of": "2026-11-14", "model": {"metrics": {"model_assessment": {
                "ridge": {
                    "score": 0.8,
                    "directional_accuracy": 72.0,
                    "rmse": 0.01,
                    "baseline_rmse_ratio": 0.9,
                    "anomaly_rate": 0.05,
                    "eligible": True,
                }
            }}}},
            {"analyses_seen": 2, "models": {}},
        )
        self.assertEqual(updated["analyses_seen"], 3)
        self.assertEqual(updated["models"]["ridge"]["samples"], 1)
        self.assertEqual(updated["models"]["ridge"]["directional_accuracy"], 72.0)
        self.assertEqual(updated["accuracy_target_percent"], 70)


if __name__ == "__main__":
    unittest.main()
