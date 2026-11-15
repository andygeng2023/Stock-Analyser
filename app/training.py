"""Retrain the adaptive ensemble and persist its rolling model-performance memory."""
import json
from datetime import datetime, timezone

from .analyzer import analyze_ticker
from .db import fetch_one, upsert_one


def analyze_and_learn(ticker, period="5y", horizon=30, progress_callback=None):
    symbol = str(ticker or "").strip().upper()
    previous_state = {}
    try:
        row = fetch_one(
            "SELECT state FROM model_learning_state WHERE ticker=%s",
            (symbol,),
        )
        if row and row.get("state"):
            raw = row["state"]
            previous_state = json.loads(raw) if isinstance(raw, str) else raw
            if not isinstance(previous_state, dict):
                previous_state = {}
    except Exception as exc:
        # A first deployment may race the schema migration. The analysis still
        # trains on the complete current history and can continue without memory.
        print(f"Model learning memory unavailable for {symbol}; starting fresh: {str(exc)[:160]}")

    result = analyze_ticker(
        symbol,
        period=period,
        horizon=horizon,
        progress_callback=progress_callback,
        learning_state=previous_state,
    )
    state = (result.get("model") or {}).get("learning_state")
    if isinstance(state, dict):
        state["analyses_seen"] = int(previous_state.get("analyses_seen", 0) or 0) + 1
        state["last_trained_at"] = datetime.now(timezone.utc).isoformat()
        state["last_data_date"] = result.get("as_of")
        try:
            upsert_one(
                "model_learning_state",
                {
                    "ticker": symbol,
                    "state": json.dumps(state, ensure_ascii=False, separators=(",", ":")),
                    "updated_at": state["last_trained_at"],
                },
                ("ticker",),
            )
        except Exception as exc:
            print(f"Could not persist model learning memory for {symbol}: {str(exc)[:160]}")
    return result
