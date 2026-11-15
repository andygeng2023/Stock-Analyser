"""Adaptive model selection and robust hybrid forecasting."""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import (
    AdaBoostRegressor,
    ExtraTreesRegressor,
    GradientBoostingRegressor,
    HistGradientBoostingRegressor,
    RandomForestRegressor,
)
from sklearn.linear_model import BayesianRidge, ElasticNet, HuberRegressor, LinearRegression, Ridge
from sklearn.tree import DecisionTreeRegressor
from sklearn.neighbors import KNeighborsRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVR
from xgboost import XGBRegressor


def build_regressors(profile="preview"):
    """Return fresh estimators; FullIndex adds slower, complementary learners."""
    if profile not in {"preview", "full"}:
        raise ValueError("Unknown model profile.")
    models = {
        "svr_rbf": lambda: make_pipeline(
            StandardScaler(), SVR(kernel="rbf", C=4.0, epsilon=0.0005, gamma="scale")
        ),
        "svr_linear": lambda: make_pipeline(
            StandardScaler(), SVR(kernel="linear", C=1.0, epsilon=0.0005)
        ),
        "ridge": lambda: make_pipeline(StandardScaler(), Ridge(alpha=8.0)),
        "elastic_net": lambda: make_pipeline(
            StandardScaler(),
            ElasticNet(alpha=0.0008, l1_ratio=0.25, max_iter=10000, random_state=42),
        ),
        "random_forest": lambda: RandomForestRegressor(
            n_estimators=110, max_depth=5, min_samples_leaf=4,
            max_features=0.85, random_state=42, n_jobs=1,
        ),
        "extra_trees": lambda: ExtraTreesRegressor(
            n_estimators=110, max_depth=5, min_samples_leaf=4,
            max_features=0.85, random_state=42, n_jobs=1,
        ),
        "gradient_boosting": lambda: GradientBoostingRegressor(
            n_estimators=100, learning_rate=0.025, max_depth=2,
            min_samples_leaf=4, loss="huber", random_state=42,
        ),
        "hist_gradient_boosting": lambda: HistGradientBoostingRegressor(
            max_iter=110, learning_rate=0.04, max_leaf_nodes=7,
            min_samples_leaf=15, l2_regularization=2.0, random_state=42,
        ),
        "xgboost": lambda: XGBRegressor(
            n_estimators=130, max_depth=2, learning_rate=0.03,
            subsample=0.85, colsample_bytree=0.85, min_child_weight=8,
            reg_lambda=3.0, objective="reg:squarederror",
            random_state=42, n_jobs=1, verbosity=0,
        ),
        "knn": lambda: make_pipeline(
            StandardScaler(), KNeighborsRegressor(n_neighbors=7, weights="distance")
        ),
    }
    if profile == "full":
        models.update({
            "bayesian_ridge": lambda: make_pipeline(StandardScaler(), BayesianRidge()),
            "huber": lambda: make_pipeline(StandardScaler(), HuberRegressor(
                epsilon=1.5, alpha=0.0001, max_iter=300
            )),
            "ada_boost": lambda: AdaBoostRegressor(
                estimator=DecisionTreeRegressor(max_depth=2, min_samples_leaf=5),
                n_estimators=120, learning_rate=0.025, loss="linear", random_state=42,
            ),
            "decision_tree": lambda: DecisionTreeRegressor(
                max_depth=5, min_samples_leaf=8, random_state=43,
            ),
            "linear_regression": lambda: make_pipeline(StandardScaler(), LinearRegression()),
        })
    return models



def build_hybrid_predictions(predictions):
    """Build ten first-order hybrids and three hybrids-of-hybrids.

    Inputs may be aligned NumPy arrays (validation) or scalar forecasts (live
    forecast). Missing base learners are tolerated, but each family blend
    requires at least one available member.
    """
    if not predictions:
        return {}

    def values(names):
        return [predictions[name] for name in names if name in predictions]

    def mean(names):
        items = values(names)
        return np.mean(np.stack(items, axis=0), axis=0) if items else None

    def median(names):
        items = values(names)
        return np.median(np.stack(items, axis=0), axis=0) if items else None

    def blend(parts, weights):
        available = [
            (hybrids[name] if name in hybrids else predictions[name], weight)
            for name, weight in zip(parts, weights)
            if name in hybrids or name in predictions
        ]
        if not available:
            return None
        total = sum(weight for _, weight in available)
        return sum(value * weight for value, weight in available) / total

    hybrids = {}
    definitions = {
        "hybrid_arima_svr": lambda: blend(["arima", "svr_rbf"], [0.5, 0.5]),
        "hybrid_arima_xgb": lambda: blend(["arima", "xgboost"], [0.5, 0.5]),
        "hybrid_tree_consensus": lambda: mean([
            "random_forest", "extra_trees", "gradient_boosting",
            "hist_gradient_boosting", "xgboost", "ada_boost",
        ]),
        "hybrid_linear_consensus": lambda: mean([
            "ridge", "elastic_net", "bayesian_ridge", "huber",
            "svr_linear", "linear_regression",
        ]),
        "hybrid_kernel_consensus": lambda: mean(["svr_rbf", "svr_linear", "knn"]),
        "hybrid_statistical_consensus": lambda: blend(
            ["arima", "ridge", "bayesian_ridge", "svr_linear"], [0.4, 0.2, 0.2, 0.2]
        ),
        "hybrid_robust_median": lambda: median(list(predictions)),
        "hybrid_trimmed_mean": lambda: (
            np.mean(np.sort(np.stack(list(predictions.values()), axis=0), axis=0)[
                1:-1 if len(predictions) > 2 else None
            ], axis=0) if predictions else None
        ),
        "hybrid_family_balance": lambda: blend(
            ["hybrid_tree_consensus", "hybrid_linear_consensus", "hybrid_kernel_consensus"],
            [0.4, 0.35, 0.25],
        ),
        "hybrid_diversified": lambda: blend(
            ["arima", "hybrid_tree_consensus", "hybrid_linear_consensus",
             "hybrid_kernel_consensus"], [0.25, 0.3, 0.25, 0.2]
        ),
    }
    for name, factory in definitions.items():
        try:
            value = factory()
            if value is not None and np.isfinite(np.asarray(value, dtype=float)).all():
                hybrids[name] = value
        except (ValueError, TypeError, FloatingPointError):
            continue

    # The next layer deliberately combines first-layer hybrids only.
    first = dict(hybrids)
    first_names = list(first)
    if first:
        stack_values = np.stack(list(first.values()), axis=0)
        hybrids_of_hybrids = {
            "meta_hybrid_median": np.median(stack_values, axis=0),
            "meta_hybrid_trimmed": (
                np.mean(np.sort(stack_values, axis=0)[1:-1], axis=0)
                if len(first) >= 3 else np.mean(stack_values, axis=0)
            ),
            "meta_hybrid_family_blend": (
                0.4 * first.get("hybrid_family_balance", first[first_names[0]])
                + 0.35 * first.get("hybrid_diversified", first[first_names[0]])
                + 0.25 * first.get("hybrid_robust_median", first[first_names[0]])
            ),
        }
        for name, value in hybrids_of_hybrids.items():
            if np.isfinite(np.asarray(value, dtype=float)).all():
                hybrids[name] = value
    return hybrids

def _metric_values(actual, predicted):
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    errors = actual - predicted
    rmse = float(np.sqrt(np.mean(np.square(errors))))
    mae = float(np.mean(np.abs(errors)))
    directional = float(np.mean(np.sign(actual) == np.sign(predicted)) * 100.0)
    return {
        "mae": round(mae, 7),
        "rmse": round(rmse, 7),
        "directional_accuracy": round(directional, 2),
    }


def combine_forecasts(predictions, weights, *, anomaly_floor=0.0005, threshold=4.0):
    """Combine one-step predictions while dropping cross-model outliers for this step."""
    available = {
        name: float(value)
        for name, value in predictions.items()
        if name in weights and np.isfinite(value) and float(weights[name]) > 0
    }
    if not available:
        raise ValueError("No finite, positively weighted ensemble predictions are available.")

    names = list(available)
    values = np.asarray([available[name] for name in names], dtype=float)
    center = float(np.median(values))
    mad = float(np.median(np.abs(values - center)))
    scale = max(1.4826 * mad, float(anomaly_floor), 1e-8)
    kept = [
        name for name in names
        if abs(available[name] - center) <= threshold * scale
    ]
    rejected = [name for name in names if name not in kept]

    # Never allow a transient disagreement to empty the ensemble.
    if not kept:
        kept = [max(names, key=lambda name: float(weights.get(name, 0.0)))]
        rejected = [name for name in names if name not in kept]

    total_weight = sum(float(weights[name]) for name in kept)
    if total_weight <= 0:
        return float(np.mean([available[name] for name in kept])), kept, rejected
    combined = sum(available[name] * float(weights[name]) for name in kept) / total_weight
    return float(combined), kept, rejected


def score_ensemble(predictions, actual_returns, prior_state=None):
    """Score candidate models on a chronological holdout and calculate adaptive weights.

    A model is rejected for weak directional accuracy, poor error versus a zero-return
    baseline, or repeated cross-model prediction anomalies. Previous out-of-sample
    scores provide a small stability prior, but cannot override current rejection.
    """
    actual = np.asarray(actual_returns, dtype=float).reshape(-1)
    valid = {}
    for name, values in predictions.items():
        array = np.asarray(values, dtype=float).reshape(-1)
        if len(array) == len(actual) and np.isfinite(array).all():
            valid[name] = array
    if not valid or len(actual) < 5 or not np.isfinite(actual).all():
        raise ValueError("The ensemble does not have enough finite validation data.")

    baseline_rmse = max(float(np.sqrt(np.mean(np.square(actual)))), 1e-8)
    names = list(valid)
    matrix = np.column_stack([valid[name] for name in names])
    anomaly_rates = {name: 0.0 for name in names}
    if len(names) >= 3:
        centers = np.median(matrix, axis=1)
        deviations = np.abs(matrix - centers[:, None])
        mads = np.median(deviations, axis=1)
        scale_floor = max(float(np.std(actual)) * 0.20, 0.0005)
        scales = np.maximum(1.4826 * mads, scale_floor)
        flags = deviations > (4.0 * scales[:, None])
        anomaly_rates = {
            name: float(np.mean(flags[:, index]))
            for index, name in enumerate(names)
        }

    old_models = (prior_state or {}).get("models", {})
    if not isinstance(old_models, dict):
        old_models = {}

    assessment = {}
    for name, values in valid.items():
        metrics = _metric_values(actual, values)
        rmse_ratio = metrics["rmse"] / baseline_rmse
        anomaly_rate = anomaly_rates[name]
        reasons = []
        if metrics["directional_accuracy"] < 45.0:
            reasons.append("directional_accuracy_below_45_percent")
        if rmse_ratio > 1.20:
            reasons.append("rmse_more_than_20_percent_worse_than_zero_return_baseline")
        if anomaly_rate > 0.20:
            reasons.append("repeated_cross_model_prediction_anomalies")

        rmse_skill = float(np.clip(1.0 - rmse_ratio, 0.0, 1.0))
        direction_skill = float(np.clip(
            (metrics["directional_accuracy"] - 45.0) / 20.0, 0.0, 1.0
        ))
        current_score = max(
            0.01,
            (0.60 * rmse_skill + 0.40 * direction_skill) * (1.0 - anomaly_rate),
        )
        previous = old_models.get(name, {})
        try:
            previous_score = float(previous.get("score", current_score))
        except (TypeError, ValueError, AttributeError):
            previous_score = current_score
        if not np.isfinite(previous_score):
            previous_score = current_score
        previous_score = float(np.clip(previous_score, 0.01, 1.0))
        adapted_score = 0.80 * current_score + 0.20 * previous_score
        assessment[name] = {
            **metrics,
            "baseline_rmse_ratio": round(float(rmse_ratio), 4),
            "anomaly_rate": round(float(anomaly_rate), 4),
            "current_score": round(float(current_score), 5),
            "score": round(float(adapted_score), 5),
            "eligible": not reasons,
            "fallback": False,
            "rejection_reason": "; ".join(reasons) if reasons else None,
        }

    eligible = [name for name, item in assessment.items() if item["eligible"]]
    if not eligible:
        # Retain exactly one transparent fallback rather than producing no forecast.
        fallback = min(
            names,
            key=lambda name: (
                assessment[name]["baseline_rmse_ratio"],
                -assessment[name]["directional_accuracy"],
            ),
        )
        eligible = [fallback]
        assessment[fallback]["eligible"] = True
        assessment[fallback]["fallback"] = True
        assessment[fallback]["rejection_reason"] = "retained_as_best_available_fallback"

    raw_weights = {name: max(0.01, assessment[name]["score"]) for name in eligible}
    total = sum(raw_weights.values())
    weights = {name: value / total for name, value in raw_weights.items()}

    ensemble = []
    for row_index in range(len(actual)):
        row = {name: valid[name][row_index] for name in eligible}
        value, _, _ = combine_forecasts(
            row, weights, anomaly_floor=max(float(np.std(actual)) * 0.20, 0.0005)
        )
        ensemble.append(value)

    return np.asarray(ensemble, dtype=float), weights, assessment, baseline_rmse
