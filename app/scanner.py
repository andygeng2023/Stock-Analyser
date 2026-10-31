"""Two-stage market scan: fast universe filter, then the existing ARIMA–SVR model."""
import json
import math
import urllib.request

import numpy as np
import pandas as pd
import yfinance as yf

from .analyzer import analyze_ticker

NASDAQ_URL = "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=5000&offset=0&exchange=nasdaq,nyse,amex"
FAST_CANDIDATES = 25
FINAL_RESULTS = 10
MIN_UNIVERSE = 1000


def load_universe():
    request = urllib.request.Request(
        NASDAQ_URL,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; StockAnalyser/1.0)",
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.nasdaq.com",
            "Referer": "https://www.nasdaq.com/",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        payload = json.loads(response.read().decode("utf-8"))
    rows = payload.get("data", {}).get("rows", [])
    symbols = []
    seen = set()
    for row in rows:
        symbol = str(row.get("symbol", "")).strip().upper()
        if not symbol or symbol in seen or len(symbol) > 12:
            continue
        # Exclude warrants, units, rights and other non-common-stock suffixes.
        if any(mark in symbol for mark in ("$", "/", " ", "^")):
            continue
        seen.add(symbol)
        symbols.append(symbol)
    if len(symbols) < MIN_UNIVERSE:
        raise RuntimeError(f"Market universe returned only {len(symbols)} stocks; at least {MIN_UNIVERSE} are required.")
    return symbols


def _extract_frame(data, symbol):
    if data is None or data.empty:
        return None
    if isinstance(data.columns, pd.MultiIndex):
        if symbol not in data.columns.get_level_values(0):
            return None
        frame = data[symbol]
    else:
        frame = data
    if "Close" not in frame:
        return None
    close = frame["Close"].dropna()
    volume = frame["Volume"].reindex(close.index).fillna(0) if "Volume" in frame else pd.Series(0, index=close.index)
    if len(close) < 65:
        return None
    return close.astype(float), volume.astype(float)


def fast_filter(symbols):
    """Rank a broad universe using price history only; no per-company info calls."""
    ranked = []
    chunk_size = 150
    for start in range(0, len(symbols), chunk_size):
        batch = symbols[start:start + chunk_size]
        data = yf.download(
            tickers=" ".join(batch),
            period="6mo",
            interval="1d",
            auto_adjust=True,
            group_by="ticker",
            threads=True,
            progress=False,
            timeout=45,
        )
        for symbol in batch:
            try:
                extracted = _extract_frame(data, symbol)
                if extracted is None:
                    continue
                close, volume = extracted
                price = float(close.iloc[-1])
                dollar_volume = float((close * volume).tail(20).mean())
                if not math.isfinite(price) or price < 3 or dollar_volume < 2_000_000:
                    continue
                ret_1m = float(close.iloc[-1] / close.iloc[-22] - 1)
                ret_3m = float(close.iloc[-1] / close.iloc[-64] - 1)
                volatility = float(close.pct_change().tail(60).std() * math.sqrt(252))
                trend = float(close.tail(20).mean() / close.tail(60).mean() - 1)
                if not all(math.isfinite(x) for x in (ret_1m, ret_3m, volatility, trend)):
                    continue
                # Momentum/trend with a volatility penalty; this is only a coarse screen.
                score = 0.40 * ret_3m + 0.25 * ret_1m + 0.20 * trend - 0.15 * volatility
                ranked.append({
                    "ticker": symbol,
                    "price": round(price, 4),
                    "change_percent": round(float(close.pct_change().iloc[-1] * 100), 2),
                    "fast_score": score,
                    "return_1m": ret_1m,
                    "return_3m": ret_3m,
                    "volatility": volatility,
                    "dollar_volume": dollar_volume,
                })
            except Exception:
                continue
    ranked.sort(key=lambda item: item["fast_score"], reverse=True)
    return ranked[:FAST_CANDIDATES], len(ranked)


def run_market_scan():
    symbols = load_universe()
    candidates, eligible_count = fast_filter(symbols)
    refined = []
    failures = []
    for item in candidates:
        ticker = item["ticker"]
        try:
            # Keep the detailed model identical to the Search screen's baseline.
            analysis = analyze_ticker(ticker, period="2y", horizon=30)
            metrics = analysis.get("model", {}).get("metrics", {}).get("hybrid", {})
            forecast = analysis.get("forecast", {}).get("expected_change_percent")
            if forecast is None or not math.isfinite(float(forecast)):
                continue
            directional = float(metrics.get("directional_accuracy", 0))
            rmse = float(metrics.get("rmse", 1))
            # Forecast return is tempered by validation quality and coarse-screen strength.
            quality = max(0.0, min(1.0, directional / 100.0))
            risk_penalty = min(10.0, rmse * 100.0)
            score = float(forecast) * (0.65 + 0.35 * quality) - risk_penalty
            refined.append({
                "ticker": ticker,
                "company": analysis.get("company") or ticker,
                "exchange": analysis.get("exchange"),
                "currency": analysis.get("currency", "USD"),
                "price": analysis.get("price"),
                "change_percent": analysis.get("change_percent"),
                "expected_change_percent": forecast,
                "directional_accuracy": directional,
                "validation_rmse": rmse,
                "fast_score": round(item["fast_score"], 6),
                "score": round(score, 4),
                "as_of": analysis.get("as_of"),
            })
        except Exception as exc:
            failures.append({"ticker": ticker, "error": str(exc)[:120]})
    refined.sort(key=lambda item: item["score"], reverse=True)
    return {
        "scan_type": "two_stage_arima_svr",
        "universe_size": len(symbols),
        "eligible_after_fast_filter": eligible_count,
        "arima_svr_refined": len(refined),
        "failed_refinements": len(failures),
        "as_of": pd.Timestamp.utcnow().strftime("%Y-%m-%d"),
        "results": refined[:FINAL_RESULTS],
        "notes": "Experimental model ranking, not investment advice. The fast screen uses momentum, trend, volatility and liquidity; the final ranking uses the existing ARIMA–SVR forecast and chronological validation metrics.",
    }
