"""Yahoo Finance retrieval with validated yfinance -> yahooquery fallback.

Both clients use Yahoo Finance upstream. This module improves resilience to
client-specific failures; it does not provide an independent market-data feed.
"""
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import yfinance as yf
from yahooquery import Ticker as YahooQueryTicker


MIN_ANALYSIS_ROWS = 100


def _unwrap_symbol_payload(value, ticker):
    """Return one symbol's mapping from yahooquery's symbol-keyed responses."""
    if isinstance(value, pd.DataFrame):
        if value.empty:
            return {}
        if ticker in value.index:
            value = value.loc[ticker]
        elif len(value) == 1:
            value = value.iloc[0]
        else:
            return {}
        if isinstance(value, pd.Series):
            return value.to_dict()
    if isinstance(value, pd.Series):
        return value.to_dict()
    if not isinstance(value, dict):
        return {}
    symbol = str(ticker).upper()
    for key in (symbol, symbol.lower()):
        nested = value.get(key)
        if isinstance(nested, dict):
            return nested
    # Some yahooquery modules return the symbol record directly.
    if any(key in value for key in ("longName", "shortName", "marketCap", "currency", "exchange")):
        return value
    return {}


def normalise_history(data, ticker):
    """Normalise yfinance/yahooquery daily history to a sorted OHLCV DataFrame."""
    if not isinstance(data, pd.DataFrame) or data.empty:
        return pd.DataFrame()

    frame = data.copy()
    symbol = str(ticker).upper()

    if isinstance(frame.index, pd.MultiIndex):
        selected = None
        for level in range(frame.index.nlevels):
            values = frame.index.get_level_values(level)
            upper_values = pd.Index(values.astype(str)).str.upper()
            if symbol in upper_values:
                match = values[upper_values == symbol][0]
                try:
                    selected = frame.xs(match, level=level, drop_level=True)
                    break
                except (KeyError, ValueError):
                    continue
            unique = pd.Index(values.astype(str)).unique()
            if len(unique) == 1:
                try:
                    selected = frame.xs(unique[0], level=level, drop_level=True)
                    break
                except (KeyError, ValueError):
                    continue
        if selected is None:
            return pd.DataFrame()
        frame = selected

    if isinstance(frame.columns, pd.MultiIndex):
        # A single-symbol yfinance download may still have a ticker column level.
        selected_columns = None
        for level in range(frame.columns.nlevels):
            values = pd.Index(frame.columns.get_level_values(level).astype(str)).str.upper()
            if symbol in values:
                selected_columns = frame.xs(symbol, axis=1, level=level, drop_level=True)
                break
        if selected_columns is None:
            return pd.DataFrame()
        frame = selected_columns

    aliases = {}
    for column in frame.columns:
        key = str(column).strip().lower().replace("_", " ")
        if key in {"open", "high", "low", "close", "volume"}:
            aliases[column] = key.title()
        elif key in {"adjclose", "adj close", "adjusted close"}:
            aliases[column] = "Adj Close"
    frame = frame.rename(columns=aliases)

    if "Close" not in frame.columns and "Adj Close" in frame.columns:
        frame["Close"] = frame["Adj Close"]
    if "Close" not in frame.columns:
        return pd.DataFrame()
    if "Volume" not in frame.columns:
        frame["Volume"] = 0.0

    for column in ("Open", "High", "Low", "Close", "Volume"):
        if column in frame.columns:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")

    frame = frame.replace([np.inf, -np.inf], np.nan)
    frame = frame.loc[frame["Close"].notna() & (frame["Close"] > 0)]
    frame = frame[~frame.index.duplicated(keep="last")].sort_index()
    return frame


def _valid_history(frame, minimum_rows):
    if not isinstance(frame, pd.DataFrame) or frame.empty or len(frame) < minimum_rows:
        return False
    close = pd.to_numeric(frame.get("Close"), errors="coerce").to_numpy(dtype=float)
    return len(close) >= minimum_rows and np.isfinite(close).all() and (close > 0).all()


def new_yahooquery_ticker(ticker):
    return YahooQueryTicker(str(ticker).upper(), asynchronous=False)


def fetch_yahooquery_batch_history(tickers, period="6mo"):
    """Fetch only missing scanner symbols in one yahooquery request."""
    symbols = list(dict.fromkeys(str(item).upper() for item in tickers if item))
    if not symbols:
        return {}
    client = YahooQueryTicker(symbols, asynchronous=False)
    raw = client.history(period=period, interval="1d", adj_ohlc=True)
    return {
        symbol: normalise_history(raw, symbol)
        for symbol in symbols
    }


def fetch_history(ticker, period="5y", yfinance_asset=None, minimum_rows=MIN_ANALYSIS_ROWS):
    """Try yfinance first, then yahooquery; return normalised history and provenance."""
    symbol = str(ticker).upper()
    attempts = []
    retrieved_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    asset = yfinance_asset or yf.Ticker(symbol)

    try:
        raw = asset.history(period=period, auto_adjust=True)
        primary = normalise_history(raw, symbol)
        if _valid_history(primary, minimum_rows):
            return primary, None, {
                "history_provider": "yfinance",
                "history_fallback_used": False,
                "retrieved_at_utc": retrieved_at,
                "history_interval": "1d",
                "latest_history_timestamp": pd.Timestamp(primary.index[-1]).isoformat(),
            }
        attempts.append(f"yfinance returned insufficient or invalid history ({len(primary)} usable rows)")
    except Exception as exc:
        attempts.append(f"yfinance: {str(exc)[:140]}")

    query_asset = None
    try:
        query_asset = new_yahooquery_ticker(symbol)
        raw = query_asset.history(period=period, interval="1d", adj_ohlc=True)
        fallback = normalise_history(raw, symbol)
        if _valid_history(fallback, minimum_rows):
            return fallback, query_asset, {
                "history_provider": "yahooquery",
                "history_fallback_used": True,
                "history_fallback_reason": "; ".join(attempts) or "Primary data unavailable",
                "retrieved_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "history_interval": "1d",
                "latest_history_timestamp": pd.Timestamp(fallback.index[-1]).isoformat(),
            }
        attempts.append(f"yahooquery returned insufficient or invalid history ({len(fallback)} usable rows)")
    except Exception as exc:
        attempts.append(f"yahooquery: {str(exc)[:140]}")

    raise ValueError(
        f"Neither Yahoo Finance client returned at least {minimum_rows} valid daily rows. "
        + " | ".join(attempts)
    )


def _module_mapping(client, module, ticker):
    try:
        return _unwrap_symbol_payload(getattr(client, module), ticker)
    except Exception:
        return {}


def fetch_company_info(yfinance_asset, ticker, yahooquery_asset=None):
    """Use yfinance company information and fill missing fields from yahooquery."""
    symbol = str(ticker).upper()
    info = {}
    try:
        info = yfinance_asset.get_info() or {}
        if not isinstance(info, dict):
            info = {}
    except Exception:
        info = {}

    wanted = (
        "longName", "shortName", "exchange", "currency", "marketCap",
        "trailingPE", "forwardPE", "priceToBook", "trailingEps",
        "totalRevenue", "profitMargins", "debtToEquity", "returnOnEquity",
        "dividendYield", "sector", "industry",
    )
    missing = [key for key in wanted if info.get(key) is None]
    if not missing:
        return info, "yfinance", yahooquery_asset

    query_asset = yahooquery_asset
    try:
        if query_asset is None:
            query_asset = new_yahooquery_ticker(symbol)
    except Exception:
        return info, "yfinance" if info else "unavailable", None

    modules = {
        "price": {
            "longName": ("longName",),
            "shortName": ("shortName",),
            "exchange": ("exchangeName", "exchange"),
            "currency": ("currency",),
            "marketCap": ("marketCap",),
        },
        "summary_detail": {
            "trailingPE": ("trailingPE",),
            "forwardPE": ("forwardPE",),
            "priceToBook": ("priceToBook",),
            "dividendYield": ("dividendYield",),
        },
        "key_stats": {
            "trailingEps": ("trailingEps",),
            "priceToBook": ("priceToBook",),
            "marketCap": ("marketCap",),
        },
        "financial_data": {
            "totalRevenue": ("totalRevenue",),
            "profitMargins": ("profitMargins",),
            "debtToEquity": ("debtToEquity",),
            "returnOnEquity": ("returnOnEquity",),
        },
        "asset_profile": {
            "sector": ("sector",),
            "industry": ("industry",),
        },
    }

    filled = 0
    for module, mapping in modules.items():
        data = _module_mapping(query_asset, module, symbol)
        for target, aliases in mapping.items():
            if info.get(target) is not None:
                continue
            value = next((data.get(alias) for alias in aliases if data.get(alias) is not None), None)
            if value is not None:
                info[target] = value
                filled += 1

    if filled:
        provider = "yfinance+yahooquery" if any(key in info for key in wanted if key not in missing) else "yahooquery"
    else:
        provider = "yfinance" if info else "unavailable"
    return info, provider, query_asset


def build_market_data_metadata(history_metadata, company_info_provider):
    metadata = dict(history_metadata or {})
    metadata["company_info_provider"] = company_info_provider
    metadata["source_family"] = "Yahoo Finance"
    metadata["independent_provider_count"] = 1
    metadata["realtime_quote_status"] = "not_certified"
    return metadata
