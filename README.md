# Stock Analyser

Yahoo Finance stock research dashboard with an ARIMA–SVR hybrid forecast.

## Run locally

Python 3.11 recommended.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000. API documentation: /docs.

## API

`GET /api/analyze/{ticker}?period=5y&horizon=30`

Periods: 1y, 2y, 5y, 10y, max. Forecast horizon: 1–60 trading days.

## Model methodology

ARIMA is fitted to daily log returns using a bounded AIC search. An RBF-kernel support vector regressor learns one-step-ahead ARIMA residual corrections from lagged returns, rolling volatility, RSI, MACD, volume changes and residual lags. The hybrid forecast adds the nonlinear correction to the ARIMA return forecast. Model metrics use chronological walk-forward holdout predictions.

The uncertainty band is an approximate residual-dispersion band, not a calibrated confidence interval. Business-day offsets do not account for exchange holidays. Yahoo Finance data can be delayed, incomplete or rate-limited; fundamentals may be unavailable for some symbols.

## Deployment

The included Render blueprint deploys the FastAPI service and frontend together. GitHub Pages alone cannot execute Python or yfinance; a Python-capable backend is required.

For research and education only, not investment advice. Forecasts are uncertain and are not recommendations to buy or sell securities.
