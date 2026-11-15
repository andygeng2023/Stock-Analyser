"""Two-stage market scan: fast universe filter, then the existing ARIMA–SVR model."""
import csv
import io
import json
import math
import re
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import yfinance as yf

from .training import analyze_and_learn
from .db import fetch_all

NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"
NON_COMMON_SECURITY = re.compile(r"\b(ETF|ETN|WARRANTS?|RIGHTS?|UNITS?|PREFERRED|DEBENTURES?|BONDS?|NOTES?|MUTUAL FUNDS?)\b", re.IGNORECASE)
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


def _parse_symbol_directory(payload, other_listed=False):
    """Parse Nasdaq Trader's pipe-delimited symbol directory, excluding test issues and funds."""
    reader = csv.DictReader(io.StringIO(payload.lstrip("\ufeff")), delimiter="|")
    if not reader.fieldnames:
        return set()

    columns = {str(name or "").strip().lower(): name for name in reader.fieldnames}

    def field(row, *names):
        for name in names:
            key = columns.get(name.lower())
            if key is not None and row.get(key) is not None:
                value = str(row.get(key)).strip()
                if value:
                    return value
        return ""

    symbols = set()
    for row in reader:
        raw_symbol = (
            field(row, "cqs symbol", "act symbol", "symbol", "nasdaq symbol")
            if other_listed
            else field(row, "symbol", "nasdaq symbol")
        )
        if not raw_symbol or raw_symbol.lower().startswith("file creation time"):
            continue
        if field(row, "test issue").upper() == "Y":
            continue
        if any(field(row, name).upper() == "Y" for name in (
            "etf", "leveraged etp flag", "inverse etp flag"
        )):
            continue
        security_name = field(row, "security name")
        if NON_COMMON_SECURITY.search(security_name):
            continue
        # Yahoo Finance uses hyphens for class-share tickers (e.g. BRK-B).
        symbol = _clean_symbol(raw_symbol.replace(".", "-"))
        if symbol:
            symbols.add(symbol)
    return symbols


def _load_nasdaq_universe():
    """Load the official, periodically refreshed Nasdaq Trader symbol directories."""
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; StockAnalyser/1.0)",
        "Accept": "text/plain,*/*",
    }
    symbols = set()
    errors = []
    for url, other_listed in (
        (NASDAQ_LISTED_URL, False),
        (OTHER_LISTED_URL, True),
    ):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=45) as response:
                payload = response.read().decode("utf-8-sig")
            parsed = _parse_symbol_directory(payload, other_listed=other_listed)
            symbols.update(parsed)
            print(f"Nasdaq Trader directory {url.rsplit('/', 1)[-1]}: {len(parsed):,} symbols.", flush=True)
        except Exception as exc:
            errors.append(f"{url.rsplit('/', 1)[-1]}: {str(exc)[:160]}")
    if not symbols:
        raise RuntimeError("Nasdaq Trader symbol directories returned no symbols. " + " | ".join(errors))
    if errors:
        print("Nasdaq Trader partial provider errors: " + " | ".join(errors), flush=True)
    return sorted(symbols)


def load_universe(source="both", progress_callback=None):
    source = str(source or "both").lower()
    if source not in ("yfinance", "nasdaq", "both"):
        raise ValueError("Choose yfinance, nasdaq or both as the market data source.")

    symbols = set()
    errors = []
    yahoo_count = 0
    nasdaq_count = 0

    if progress_callback: progress_callback(4, "Discovering stock universe", "Loading the official exchange symbol directories.")
    if source in ("nasdaq", "both"):
        try:
            nasdaq_symbols = _load_nasdaq_universe()
            nasdaq_count = len(nasdaq_symbols)
            symbols.update(nasdaq_symbols)
        except Exception as exc:
            errors.append("Nasdaq Trader: " + str(exc)[:180])
        if progress_callback:
            progress_callback(10, "Discovering stock universe", f"Nasdaq Trader supplied {nasdaq_count:,} unique symbols.")

    # The Yahoo screener has started returning HTTP 401. Do not make eight
    # failing calls on every scan when the official exchange directories have
    # already supplied a sufficiently broad universe. Keep Yahoo as a fallback.
    if source == "yfinance" or (source == "both" and len(symbols) < MIN_UNIVERSE):
        yahoo_symbols, yahoo_errors = _load_yfinance_universe()
        yahoo_count = len(yahoo_symbols)
        symbols.update(yahoo_symbols)
        errors.extend("Yahoo Finance: " + item for item in yahoo_errors[:3])
        if progress_callback:
            progress_callback(14, "Discovering stock universe", f"Yahoo Finance supplied {yahoo_count:,} additional symbols.")

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


def _load_fresh_indexed_analyses(tickers, max_age_hours=6):
    """Reuse recent shared RapidIndex analyses before spending compute on a rescan."""
    symbols = list(dict.fromkeys(str(ticker).upper() for ticker in tickers if ticker))
    if not symbols:
        return {}
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=max_age_hours)).isoformat()
    placeholders = ",".join(["%s"] * len(symbols))
    try:
        rows = fetch_all(
            f"""SELECT ticker,result,indexed_at FROM market_index
                WHERE ticker IN ({placeholders})
                  AND period=%s AND horizon=%s AND indexer=%s AND indexed_at>=%s""",
            tuple(symbols) + ("5y", 30, "rapidIndex", cutoff),
        )
    except Exception as exc:
        # The scanner remains functional if the shared cache is temporarily
        # unavailable; it simply falls back to fresh analysis.
        print(f"Indexed analysis lookup unavailable; using fresh analysis: {str(exc)[:160]}")
        return {}
    cached = {}
    for row in rows or []:
        result = row.get("result")
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except (TypeError, ValueError):
                continue
        if isinstance(result, dict) and result.get("forecast"):
            cached[row["ticker"]] = result
    return cached


def run_market_scan(source="both", progress_callback=None):
    symbols = load_universe(source, progress_callback)
    candidates, eligible_count = fast_filter(symbols, progress_callback)
    candidates = candidates[:FAST_CANDIDATES]
    refined = []
    failures = []
    indexed_cache = _load_fresh_indexed_analyses([item["ticker"] for item in candidates])
    reused_count = 0
    for candidate_index, item in enumerate(candidates, start=1):
        ticker = item["ticker"]
        if progress_callback:
            progress_callback(60 + int(35 * (candidate_index - 1) / max(1, len(candidates))), "ARIMA–SVR refinement", f"Refining candidate {candidate_index}/{len(candidates)}: {ticker}.")
        try:
            # Prefer a recent shared indexed analysis. This avoids repeating
            # expensive model work and upstream data requests for the same ticker.
            analysis = indexed_cache.get(ticker)
            if analysis is not None:
                reused_count += 1
                analysis_source = "rapidIndex"
            else:
                analysis = analyze_and_learn(ticker, period="5y", horizon=30, progress_callback=lambda p, stage, detail: progress_callback(60 + int(0.35 * p), stage, f"{ticker}: {detail}") if progress_callback else None)
                analysis_source = "fresh"
            metrics = analysis.get("model", {}).get("metrics", {}).get("hybrid", {})
            forecast = analysis.get("forecast", {}).get("expected_change_percent")
            if forecast is None or not math.isfinite(float(forecast)):
                continue
            directional = float(metrics.get("directional_accuracy", 0) or 0)
            rmse = float(metrics.get("rmse", 1) or 1)
            market_risk = analysis.get("market_summary", {})
            annual_volatility = market_risk.get("annualized_volatility")
            max_drawdown = market_risk.get("max_drawdown")
            if annual_volatility is None or max_drawdown is None:
                # Do not silently present missing risk data as low risk.
                risk_score = 100.0
            else:
                volatility_risk = min(100.0, max(0.0, float(annual_volatility)) / 80.0 * 100.0)
                drawdown_risk = min(100.0, max(0.0, abs(float(max_drawdown))) / 60.0 * 100.0)
                validation_error_pct = max(0.0, float(rmse) * 100.0)
                error_risk = min(100.0, validation_error_pct / 8.0 * 100.0)
                accuracy_risk = min(100.0, max(0.0, (75.0 - directional) / 35.0 * 100.0))
                risk_score = 0.45 * volatility_risk + 0.25 * drawdown_risk + 0.20 * error_risk + 0.10 * accuracy_risk
            risk_score = round(min(100.0, max(0.0, risk_score)), 1)
            risk_level = "Lower" if risk_score < 30 else "Moderate" if risk_score < 60 else "Higher"
            refined.append({
                "ticker": ticker,
                "company": analysis.get("company") or ticker,
                "exchange": analysis.get("exchange"),
                "currency": analysis.get("currency", "USD"),
                "price": analysis.get("price"),
                "change_percent": analysis.get("change_percent"),
                "expected_change_percent": round(float(forecast), 2),
                "directional_accuracy": round(directional, 2),
                "validation_rmse": rmse,
                "annualized_volatility": annual_volatility,
                "max_drawdown": max_drawdown,
                "risk_score": risk_score,
                "risk_level": risk_level,
                "analysis_source": analysis_source,
                "fast_score": round(item["fast_score"], 6),
                "as_of": analysis.get("as_of"),
            })
        except Exception as exc:
            failures.append({"ticker": ticker, "error": str(exc)[:120]})
    # Expected 30-day return is the primary ranking; lower estimated risk breaks ties.
    refined.sort(key=lambda item: (
        -float(item.get("expected_change_percent", -1e9)),
        float(item.get("risk_score", 100.0)),
        -float(item.get("directional_accuracy", 0.0)),
    ))
    if progress_callback: progress_callback(100, "Ranking complete", f"Ranked {min(len(refined), FINAL_RESULTS)} results from {len(refined)} successful refinements.")
    return {
        "model_version": "adaptive-ensemble-v3",
        "scan_type": "two_stage_adaptive_risk_ranked",
        "source": source,
        "universe_size": len(symbols),
        "eligible_after_fast_filter": eligible_count,
        "arima_svr_refined": len(refined),
        "indexed_analyses_reused": reused_count,
        "fresh_analyses_computed": len(refined) - reused_count,
        "failed_refinements": len(failures),
        "as_of": pd.Timestamp.utcnow().strftime("%Y-%m-%d"),
        "results": refined[:FINAL_RESULTS],
        "ranking": {"primary": "expected_change_percent_desc", "secondary": "risk_score_asc", "risk_scale": "0=lower estimated risk, 100=higher estimated risk", "risk_inputs": ["annualized_volatility", "max_drawdown", "validation_rmse", "directional_accuracy"]},
        "notes": "Experimental model screening, not investment advice. Results are ranked by expected 30-day return, with lower estimated risk used as the secondary sort. Risk scores combine annualised volatility, historical maximum drawdown, chronological validation error and directional accuracy. Forecasts and risk estimates are uncertain and can be wrong.",
    }
