"""Globally adaptive analysis training.

The ticker-local profile and a deployment-wide profile are stored in the existing
model_learning_state table. Only aggregate validation metrics are shared; no user
identity or account-specific information enters the training state.
"""
import json
from datetime import datetime, timezone

from .analyzer import analyze_ticker
from .db import connect, fetch_one

GLOBAL_KEYS = {
    "previewIndex": "__GLOBAL_PREVIEW__",
    "FullIndex": "__GLOBAL_FULL__",
}


def _decode_state(raw):
    if not raw:
        return {}
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _profile_state(root, indexer):
    if not isinstance(root, dict):
        return {}
    profiles = root.get("profiles")
    if isinstance(profiles, dict):
        value = profiles.get(indexer)
        return value if isinstance(value, dict) else {}
    # Older deployments stored one flat ticker state. Treat it as PreviewIndex
    # history so the rename does not throw away the existing adaptive prior.
    return root if indexer == "previewIndex" else {}


def _load_profile(key, indexer):
    try:
        row = fetch_one(
            "SELECT state FROM model_learning_state WHERE ticker=%s",
            (key,),
        )
        return _profile_state(_decode_state((row or {}).get("state")), indexer)
    except Exception as exc:
        print(f"Shared learning memory unavailable for {key}: {str(exc)[:160]}")
        return {}


def _store_profile(key, indexer, profile):
    """Serialize concurrent writes to one learning key with a row lock."""
    now = datetime.now(timezone.utc).isoformat()
    empty = json.dumps({"version": 2, "profiles": {}}, separators=(",", ":"))
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """INSERT INTO model_learning_state(ticker,state,updated_at)
               VALUES(%s,%s,%s) ON CONFLICT(ticker) DO NOTHING""",
            (key, empty, now),
        )
        cur.execute(
            "SELECT state FROM model_learning_state WHERE ticker=%s FOR UPDATE",
            (key,),
        )
        row = cur.fetchone() or {}
        root = _decode_state(row.get("state"))
        profiles = root.get("profiles") if isinstance(root.get("profiles"), dict) else {}
        if not profiles and root and key not in GLOBAL_KEYS.values():
            profiles["previewIndex"] = root
        profiles[indexer] = profile
        payload = json.dumps(
            {"version": 2, "profiles": profiles},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        cur.execute(
            "UPDATE model_learning_state SET state=%s,updated_at=%s WHERE ticker=%s",
            (payload, now, key),
        )


def _merge_prior(local_state, global_state):
    """Blend symbol-specific evidence with the deployment-wide model prior."""
    local_models = local_state.get("models", {}) if isinstance(local_state, dict) else {}
    global_models = global_state.get("models", {}) if isinstance(global_state, dict) else {}
    if not isinstance(local_models, dict):
        local_models = {}
    if not isinstance(global_models, dict):
        global_models = {}

    merged = {}
    for name in set(local_models) | set(global_models):
        local = local_models.get(name) if isinstance(local_models.get(name), dict) else {}
        shared = global_models.get(name) if isinstance(global_models.get(name), dict) else {}
        try:
            local_score = float(local.get("score"))
        except (TypeError, ValueError):
            local_score = None
        try:
            global_score = float(shared.get("score"))
        except (TypeError, ValueError):
            global_score = None
        if local_score is not None and global_score is not None:
            score = 0.35 * local_score + 0.65 * global_score
        else:
            score = local_score if local_score is not None else global_score
        if score is not None:
            merged[name] = {"score": max(0.01, min(1.0, score))}

    return {
        "analyses_seen": int(local_state.get("analyses_seen", 0) or 0)
        if isinstance(local_state, dict) else 0,
        "models": merged,
        "global_analyses_seen": int(global_state.get("analyses_seen", 0) or 0)
        if isinstance(global_state, dict) else 0,
    }


def _update_global_profile(indexer, result, previous_global):
    """Update EWMA model skill from a new chronological holdout evaluation."""
    model = result.get("model") or {}
    metrics = model.get("metrics") or {}
    assessment = metrics.get("model_assessment") or {}
    if not isinstance(assessment, dict) or not assessment:
        return previous_global

    previous_models = previous_global.get("models", {})
    if not isinstance(previous_models, dict):
        previous_models = {}
    updated_models = dict(previous_models)
    alpha = 0.20

    for name, record in assessment.items():
        if not isinstance(record, dict):
            continue
        old = previous_models.get(name, {})
        if not isinstance(old, dict):
            old = {}
        current = {
            "score": record.get("score"),
            "directional_accuracy": record.get("directional_accuracy"),
            "rmse": record.get("rmse"),
            "baseline_rmse_ratio": record.get("baseline_rmse_ratio"),
            "anomaly_rate": record.get("anomaly_rate"),
        }
        merged = {}
        for field, value in current.items():
            try:
                value = float(value)
            except (TypeError, ValueError):
                continue
            try:
                old_value = float(old.get(field))
            except (TypeError, ValueError):
                old_value = value
            merged[field] = round((1.0 - alpha) * old_value + alpha * value, 7)
        merged["samples"] = int(old.get("samples", 0) or 0) + 1
        merged["eligible_rate"] = round(
            0.8 * float(old.get("eligible_rate", 1.0 if record.get("eligible") else 0.0))
            + 0.2 * (1.0 if record.get("eligible") else 0.0),
            5,
        )
        updated_models[name] = merged

    now = datetime.now(timezone.utc).isoformat()
    return {
        "version": 2,
        "analyses_seen": int(previous_global.get("analyses_seen", 0) or 0) + 1,
        "models": updated_models,
        "last_updated_at": now,
        "last_data_date": result.get("as_of"),
        "accuracy_target_percent": 70,
    }


def analyze_and_learn(
    ticker,
    period="5y",
    horizon=30,
    progress_callback=None,
    indexer="previewIndex",
):
    """Analyze, adapt and persist the globally shared profile for this indexer."""
    if indexer not in GLOBAL_KEYS:
        raise ValueError("Unknown learning profile.")
    symbol = str(ticker or "").strip().upper()
    global_key = GLOBAL_KEYS[indexer]

    local_state = _load_profile(symbol, indexer)
    global_state = _load_profile(global_key, indexer)
    prior_state = _merge_prior(local_state, global_state)

    result = analyze_ticker(
        symbol,
        period=period,
        horizon=horizon,
        progress_callback=progress_callback,
        learning_state=prior_state,
        model_profile="full" if indexer == "FullIndex" else "preview",
    )

    now = datetime.now(timezone.utc).isoformat()
    state = (result.get("model") or {}).get("learning_state")
    if isinstance(state, dict):
        state = dict(state)
        state["analyses_seen"] = int(local_state.get("analyses_seen", 0) or 0) + 1
        state["last_trained_at"] = now
        state["last_data_date"] = result.get("as_of")
        try:
            _store_profile(symbol, indexer, state)
        except Exception as exc:
            print(f"Could not persist ticker learning memory for {symbol}: {str(exc)[:160]}")

    updated_global = _update_global_profile(indexer, result, global_state)
    try:
        _store_profile(global_key, indexer, updated_global)
    except Exception as exc:
        print(f"Could not persist global learning memory for {indexer}: {str(exc)[:160]}")

    model = result.setdefault("model", {})
    model["learning"] = {
        "profile": indexer,
        "scope": "shared deployment-wide aggregate validation memory",
        "global_analyses_seen": int(updated_global.get("analyses_seen", 0) or 0),
        "ticker_analyses_seen": int(state.get("analyses_seen", 0) or 0) if isinstance(state, dict) else 0,
        "updated_at": now,
    }
    return result
