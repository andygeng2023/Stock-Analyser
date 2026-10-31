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


def _clean_symbol(value):
    symbol = str(value or "").strip().upper()
    if not symbol or len(symbol) > 12:
        return None
    if any(mark in symbol for mark in ("$", "/", " ", "^", "=")):
        return None
    return symbol


def _load_yfinance_universe():
    """Build a broad ticker set from Yahoo Finance's own screener endpoints."""
    screens = (
        "most_actives",
        "day_gainers",
        "day_losers",
        "growth_technology_stocks",
        "undervalued_growth_stocks",
        "aggressive_small_caps",
        "small_cap_gainers",
        "portfolio_anchors",
    )
    symbols = set()
    errors = []
    for screen_name in screens:
        try:
            result = yf.screen(screen_name, offset=0, size=250)
            quotes = result.get("quotes", []) if isinstance(result, dict) else []
            for quote in quotes:
                if isinstance(quote, dict):
                    symbol = _clean_symbol(quote.get("symbol") or quote.get("ticker"))
                    if symbol:
                        symbols.add(symbol)
        except Exception as exc:
            errors.append(f"{screen_name}: {str(exc)[:100]}")
    return sorted(symbols), errors


def _load_nasdaq_universe():
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
    data = payload.get("data") or {}
    table = data.get("table") or {}
    rows = table.get("rows") or data.get("rows") or []
    headers = table.get("headers") or []
    header_names = [
        str(item.get("name", "") if isinstance(item, dict) else item).strip().lower()
        for item in headers
    ]
    symbols = set()
    for row in rows if isinstance(rows, list) else []:
        raw_symbol = None
        if isinstance(row, dict):
            fields = {str(key).strip().lower(): value for key, value in row.items()}
            raw_symbol = fields.get("symbol") or fields.get("ticker") or fields.get("nasdaq symbol")
        elif isinstance(row, (list, tuple)):
            for candidate in ("symbol", "ticker"):
                try:
                    raw_symbol = row[header_names.index(candidate)]
                    break
                except (ValueError, IndexError):
                    continue
        symbol = _clean_symbol(raw_symbol)
        if symbol:
            symbols.add(symbol)
    return sorted(symbols)


def load_universe(source="both", progress_callback=None):
    source = str(source or "both").lower()
    if source not in ("yfinance", "nasdaq", "both"):
        raise ValueError("Choose yfinance, nasdaq or both as the market data source.")

    symbols = set()
    errors = []
    yahoo_count = 0
    nasdaq_count = 0

    if progress_callback: progress_callback(4, "Discovering stock universe", "Querying selected stock-universe providers.")
    if source in ("yfinance", "both"):
        yahoo_symbols, yahoo_errors = _load_yfinance_universe()
        yahoo_count = len(yahoo_symbols)
        symbols.update(yahoo_symbols)
        errors.extend("Yahoo Finance: " + item for item in yahoo_errors[:3])
        if progress_callback: progress_callback(10, "Discovering stock universe", f"Yahoo Finance supplied {yahoo_count:,} unique symbols.")

    if source in ("nasdaq", "both"):
        try:
            nasdaq_symbols = _load_nasdaq_universe()
            nasdaq_count = len(nasdaq_symbols)
            symbols.update(nasdaq_symbols)
        except Exception as exc:
            errors.append("Nasdaq: " + str(exc)[:180])
        if progress_callback: progress_callback(14, "Discovering stock universe", f"Combined universe currently contains {len(symbols):,} symbols.")

    symbols = sorted(symbols)
    if len(symbols) < MIN_UNIVERSE:
        detail = (
            f"Selected source: {source}. Yahoo Finance supplied {yahoo_count}; "
            f"Nasdaq supplied {nasdaq_count}; {len(symbols)} unique symbols total. "
            f"At least {MIN_UNIVERSE} are required."
        )
        if errors:
            detail += " Provider details: " + " | ".join(errors)
        raise RuntimeError(detail)
    if progress_callback: progress_callback(18, "Stock universe ready", f"{len(symbols):,} unique symbols will be screened.")
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


def fast_filter(symbols, progress_callback=None):
    """Rank a broad universe using price history only; no per-company info calls."""
    ranked = []
    chunk_size = 150
    total_batches = max(1, math.ceil(len(symbols) / chunk_size))
    for batch_number, start in enumerate(range(0, len(symbols), chunk_size), start=1):
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
        if progress_callback:
            progress = 18 + int(42 * batch_number / total_batches)
            progress_callback(progress, "Fast market filter", f"Downloaded batch {batch_number}/{total_batches}; {len(ranked):,} stocks currently pass liquidity and history checks.")
    ranked.sort(key=lambda item: item["fast_score"], reverse=True)
    return ranked, len(ranked)


def run_market_scan(source="both", progress_callback=None):
    symbols = load_universe(source, progress_callback)
    candidates, eligible_count = fast_filter(symbols, progress_callback)
    candidates = candidates[:FAST_CANDIDATES]
    refined = []
    failures = []
    for candidate_index, item in enumerate(candidates, start=1):
        ticker = item["ticker"]
        if progress_callback:
            progress_callback(60 + int(35 * (candidate_index - 1) / max(1, len(candidates))), "ARIMA–SVR refinement", f"Refining candidate {candidate_index}/{len(candidates)}: {ticker}.")
        try:
            # Keep the detailed model identical to the Search screen's baseline.
            analysis = analyze_ticker(ticker, period="5y", horizon=30, progress_callback=lambda p, stage, detail: progress_callback(60 + int(0.35 * p), stage, f"{ticker}: {detail}") if progress_callback else None)
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
    if progress_callback: progress_callback(100, "Ranking complete", f"Ranked {min(len(refined), FINAL_RESULTS)} results from {len(refined)} successful refinements.")
    return {
        "scan_type": "two_stage_arima_svr",
        "source": source,
        "universe_size": len(symbols),
        "eligible_after_fast_filter": eligible_count,
        "arima_svr_refined": len(refined),
        "failed_refinements": len(failures),
        "as_of": pd.Timestamp.utcnow().strftime("%Y-%m-%d"),
        "results": refined[:FINAL_RESULTS],
        "notes": "Experimental model ranking, not investment advice. The fast screen uses momentum, trend, volatility and liquidity; the final ranking uses the existing ARIMA–SVR forecast and chronological validation metrics.",
    }
