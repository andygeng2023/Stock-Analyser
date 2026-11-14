"""One-shot diagnostics for the market-data bootstrap pipeline."""
from app.db import fetch_all, verify_database
from app.scanner import _load_yfinance_universe, _load_nasdaq_universe, fast_filter

print("DATABASE PREFLIGHT", verify_database(), flush=True)

for label, query in [
    ("MARKET INDEX COUNTS", "SELECT indexer,period,horizon,COUNT(*) AS n FROM market_index GROUP BY indexer,period,horizon ORDER BY indexer,period,horizon"),
    ("CATALOGUE COUNT", "SELECT COUNT(*) AS n FROM market_index_catalog"),
    ("ANALYSIS JOB COUNTS", "SELECT job_type,status,COUNT(*) AS n FROM analysis_jobs GROUP BY job_type,status ORDER BY job_type,status"),
    ("LATEST INDEX ROWS", "SELECT ticker,indexer,period,horizon,indexed_at FROM market_index ORDER BY indexed_at DESC LIMIT 10"),
    ("LATEST FAILED JOBS", "SELECT ticker,job_type,status,error,updated_at FROM analysis_jobs WHERE status='failed' ORDER BY updated_at DESC LIMIT 10"),
]:
    try:
        print(label, fetch_all(query), flush=True)
    except Exception as exc:
        print(label, "QUERY FAILED:", repr(exc), flush=True)

yahoo_symbols, yahoo_errors = [], []
try:
    yahoo_symbols, yahoo_errors = _load_yfinance_universe()
    print("YAHOO UNIVERSE", len(yahoo_symbols), yahoo_symbols[:20], "errors=", yahoo_errors, flush=True)
except Exception as exc:
    print("YAHOO UNIVERSE FAILED", repr(exc), flush=True)

nasdaq_symbols = []
try:
    nasdaq_symbols = _load_nasdaq_universe()
    print("NASDAQ UNIVERSE", len(nasdaq_symbols), nasdaq_symbols[:20], flush=True)
except Exception as exc:
    print("NASDAQ UNIVERSE FAILED", repr(exc), flush=True)

symbols = sorted(set(yahoo_symbols) | set(nasdaq_symbols))
print("COMBINED UNIVERSE", len(symbols), flush=True)
if symbols:
    try:
        sample = symbols[:150]
        ranked, eligible = fast_filter(sample)
        print("YAHOO BULK PRICE TEST", {"requested": len(sample), "eligible": eligible, "sample": ranked[:10]}, flush=True)
    except Exception as exc:
        print("YAHOO BULK PRICE TEST FAILED", repr(exc), flush=True)
