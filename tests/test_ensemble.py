import unittest

import numpy as np

from app.ensemble import combine_forecasts, score_ensemble


class AdaptiveEnsembleTests(unittest.TestCase):
    def setUp(self):
        self.actual = np.asarray([
            0.012, -0.009, 0.014, -0.006, 0.008, -0.011,
            0.016, -0.004, 0.010, -0.008, 0.013, -0.005,
            0.009, -0.012, 0.015, -0.007, 0.011, -0.003,
            0.014, -0.010, 0.007, -0.006, 0.012, -0.004,
        ])

    def test_rejects_weak_and_anomalous_models_and_normalises_weights(self):
        actual = self.actual
        predictions = {
            "strong_a": actual.copy(),
            "strong_b": actual * 1.02,
            "anomalous": actual * 15.0,
            "low_accuracy": -actual,
        }
        combined, weights, assessment, baseline = score_ensemble(predictions, actual)

        self.assertIn("strong_a", weights)
        self.assertIn("strong_b", weights)
        self.assertNotIn("anomalous", weights)
        self.assertNotIn("low_accuracy", weights)
        self.assertAlmostEqual(sum(weights.values()), 1.0, places=8)
        self.assertLess(float(np.sqrt(np.mean((actual - combined) ** 2))), baseline)
        self.assertFalse(assessment["anomalous"]["eligible"])
        self.assertFalse(assessment["low_accuracy"]["eligible"])

    def test_step_level_anomaly_is_removed_before_hybrid_blend(self):
        value, kept, rejected = combine_forecasts(
            {"arima": 0.0010, "svr": 0.0011, "forest": 0.00105, "rogue": 0.25},
            {"arima": 0.25, "svr": 0.25, "forest": 0.25, "rogue": 0.25},
            anomaly_floor=0.0005,
        )
        self.assertIn("rogue", rejected)
        self.assertNotIn("rogue", kept)
        self.assertAlmostEqual(value, 0.00105, places=5)

    def test_keeps_a_transparent_fallback_if_every_model_fails_gates(self):
        actual = np.abs(self.actual) + 0.01
        _, weights, assessment, _ = score_ensemble(
            {"bad_model": -actual},
            actual,
        )
        self.assertEqual(list(weights), ["bad_model"])
        self.assertTrue(assessment["bad_model"]["fallback"])
        self.assertIn("fallback", assessment["bad_model"]["rejection_reason"])


if __name__ == "__main__":
    unittest.main()
