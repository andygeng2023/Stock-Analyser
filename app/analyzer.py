import numpy as np
import pandas as pd
import yfinance as yf
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.stattools import adfuller
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVR
from sklearn.metrics import mean_absolute_error, mean_squared_error
from .errors import AnalysisError

ORDERS = [(1,0,0),(0,0,1),(1,0,1),(2,0,1),(2,0,2)]

def _select_order(series):
    candidates=[]
    for order in ORDERS:
        try:
            # Use a numeric index: Yahoo Finance DatetimeIndex values often have
            # no fixed frequency, which prevents statsmodels append() from
            # extending the fitted model during one-step-ahead validation.
            fitted=ARIMA(np.asarray(series,dtype=float),order=order,enforce_stationarity=False,enforce_invertibility=False).fit()
            candidates.append((float(fitted.aic),order,fitted))
        except Exception:
            continue
    if not candidates:
        raise AnalysisError("ARIMA fitting failed.")
    _,order,fitted=min(candidates,key=lambda item:item[0])
    return order,fitted

def _feature_frame(close,volume,returns,residuals):
    r=returns.reindex(close.index)
    e=residuals.reindex(close.index)
    x=pd.DataFrame(index=close.index)
    # A row dated t uses information available through t to predict the next session.
    for lag in range(1,6):
        x[f"r{lag}"]=r.shift(lag-1)
    x["vol5"]=r.rolling(5).std()
    x["vol20"]=r.rolling(20).std()
    delta=close.diff()
    gain=delta.clip(lower=0).ewm(alpha=1/14,adjust=False).mean()
    loss=(-delta.clip(upper=0)).ewm(alpha=1/14,adjust=False).mean()
    rs=gain/loss.replace(0,np.nan)
    x["rsi"]=(100-100/(1+rs)).fillna(100)
    x["macd"]=(close.ewm(span=12).mean()-close.ewm(span=26).mean())/close
    x["volume_change"]=volume.pct_change().replace([np.inf,-np.inf],np.nan).clip(-5,5)
    for lag in range(1,4):
        x[f"e{lag}"]=e.shift(lag-1)
    return x

def _metrics(actual,predicted):
    return {
        "mae":round(float(mean_absolute_error(actual,predicted)),7),
        "rmse":round(float(np.sqrt(mean_squared_error(actual,predicted))),7),
        "directional_accuracy":round(float(np.mean(np.sign(actual)==np.sign(predicted))*100),2),
    }

def analyze_ticker(ticker,period="5y",horizon=30,progress_callback=None):
    ticker=ticker.strip().upper()
    if not ticker or len(ticker)>20 or not all(c.isalnum() or c in ".-^=" for c in ticker):
        raise AnalysisError("Enter a valid ticker.")
    if period not in {"1y","2y","5y","10y","max"}:
        raise AnalysisError("Invalid history period.")
    if not 1<=horizon<=504:
        raise AnalysisError("Forecast horizon must be 1–504 trading days.")
    try:
        asset=yf.Ticker(ticker)
        history=asset.history(period=period,auto_adjust=True)
        if history.empty or len(history)<100:
            raise AnalysisError("Insufficient price history. Check the ticker.")
        if progress_callback: progress_callback(8, "Downloading price history", f"Loaded {len(history):,} historical rows.")
        close=history["Close"].dropna().astype(float)
        volume=history["Volume"].reindex(close.index).fillna(0)
        returns=np.log(close/close.shift(1)).dropna()
        if len(returns)<90:
            raise AnalysisError("At least 90 daily returns are required.")

        # Chronological holdout. Select ARIMA parameters using training data only.
        split=max(60,int(len(returns)*0.8))
        split=min(split,len(returns)-20)
        train_returns=returns.iloc[:split]
        if progress_callback: progress_callback(20, "Fitting ARIMA model", "Selecting ARIMA parameters using the training window.")
        order,train_arima=_select_order(train_returns)

        # Generate genuine one-step-ahead ARIMA residuals throughout the holdout.
        residuals=pd.Series(index=returns.index,dtype=float)
        residuals.iloc[:split]=np.asarray(train_arima.resid,dtype=float)
        state=train_arima
        arima_predictions=[]
        test_returns=returns.iloc[split:]
        for date,actual in test_returns.items():
            # Array-backed ARIMA results return NumPy arrays, not pandas Series.
            forecast=float(np.asarray(state.forecast(1),dtype=float).reshape(-1)[0])
            arima_predictions.append(forecast)
            residuals.loc[date]=float(actual)-forecast
            # Keep appended observations on the same numeric index as the fitted model.
            state=state.append(np.asarray([actual],dtype=float),refit=False)

        if progress_callback: progress_callback(42, "Validating model", "Running chronological one-step-ahead validation.")
        features=_feature_frame(close,volume,returns,residuals)
        target=residuals.reindex(close.index).shift(-1)
        data=features.assign(target=target).replace([np.inf,-np.inf],np.nan).dropna()
        feature_dates=returns.index[split-1:-1]
        test_data=data.reindex(feature_dates).dropna()
        if len(test_data)!=len(test_returns):
            raise AnalysisError("Could not align the chronological model validation window.")
        train_data=data.loc[data.index < returns.index[split-1]]
        if len(train_data)<40:
            raise AnalysisError("Not enough clean observations to train the SVR model.")

        def make_model():
            return make_pipeline(StandardScaler(),SVR(kernel="rbf",C=10,epsilon=0.001))
        svr_validation=make_model().fit(train_data.drop(columns="target"),train_data["target"])
        predicted_residuals=svr_validation.predict(test_data.drop(columns="target"))
        actual_returns=test_returns.to_numpy(dtype=float)
        actual_residuals=residuals.loc[test_returns.index].to_numpy(dtype=float)
        predicted_arima=np.asarray(arima_predictions,dtype=float)
        metrics={
            "arima":_metrics(actual_returns,predicted_arima),
            "svm_residual":_metrics(actual_residuals,predicted_residuals),
            "hybrid":_metrics(actual_returns,predicted_arima+predicted_residuals),
        }

        if progress_callback: progress_callback(65, "Fitting SVR and final ARIMA model", "Training the hybrid model on the full history.")
        # Refit both components on all available observations for the live forecast.
        full_order,full_arima=_select_order(returns)
        full_residuals=pd.Series(np.asarray(full_arima.resid,dtype=float),index=returns.index)
        full_features=_feature_frame(close,volume,returns,full_residuals)
        full_target=full_residuals.reindex(close.index).shift(-1)
        full_data=full_features.assign(target=full_target).replace([np.inf,-np.inf],np.nan).dropna()
        if len(full_data)<45:
            raise AnalysisError("Not enough clean observations for the final SVR model.")
        svr=make_model().fit(full_data.drop(columns="target"),full_data["target"])

        if progress_callback: progress_callback(80, "Generating forecast", "Calculating the requested forecast horizon.")
        base=np.asarray(full_arima.forecast(horizon),dtype=float)
        recent=list(returns.iloc[-20:].to_numpy(dtype=float))
        errors=list(full_residuals.iloc[-3:].to_numpy(dtype=float))
        last=float(close.iloc[-1])
        forecast_path=[]; arima_path=[]; lower=[]; upper=[]
        sigma=float(np.nanstd(full_residuals))
        rsi_now=float(full_features["rsi"].iloc[-1])
        macd_now=float(full_features["macd"].iloc[-1])
        volume_change=float(full_features["volume_change"].iloc[-1])
        for i in range(horizon):
            row={
                **{f"r{j}":recent[-j] for j in range(1,6)},
                "vol5":float(np.std(recent[-5:])),
                "vol20":float(np.std(recent[-20:])),
                "rsi":rsi_now,
                "macd":macd_now,
                "volume_change":volume_change,
                **{f"e{j}":errors[-j] for j in range(1,4)},
            }
            correction=float(svr.predict(pd.DataFrame([row],columns=full_data.drop(columns="target").columns))[0])
            arima_path.append(float(close.iloc[-1])*float(np.exp(np.sum(base[:i+1]))))
            next_return=float(base[i]+correction)
            last*=float(np.exp(next_return))
            forecast_path.append(last)
            band=1.96*sigma*np.sqrt(i+1)
            lower.append(last*float(np.exp(-band)))
            upper.append(last*float(np.exp(band)))
            recent.append(next_return)
            errors.append(correction)

        if progress_callback: progress_callback(90, "Loading company details", "Retrieving available company fundamentals.")
        info={}
        try:
            info=asset.get_info() or {}
        except Exception:
            pass
        def val(key):
            value=info.get(key)
            return round(float(value),4) if isinstance(value,(int,float,np.number)) and np.isfinite(value) else None

        delta=close.diff()
        gain=delta.clip(lower=0).ewm(alpha=1/14,adjust=False).mean()
        loss=(-delta.clip(upper=0)).ewm(alpha=1/14,adjust=False).mean()
        rsi=float((100-100/(1+gain.iloc[-1]/loss.iloc[-1]))) if loss.iloc[-1]>0 else 100.0
        ema12=close.ewm(span=12).mean()
        ema26=close.ewm(span=26).mean()
        macd=ema12-ema26
        middle=close.rolling(20).mean()
        deviation=close.rolling(20).std()
        drawdown=close/close.cummax()-1
        annual_vol=float(returns.tail(252).std()*np.sqrt(252)*100)
        chart=history
        forecast_dates=pd.bdate_range(close.index[-1]+pd.offsets.BDay(1),periods=horizon)

        return {
            "ticker":ticker,
            "company":info.get("longName") or info.get("shortName") or ticker,
            "exchange":info.get("exchange"),
            "currency":info.get("currency") or "USD",
            "as_of":close.index[-1].strftime("%Y-%m-%d"),
            "price":round(float(close.iloc[-1]),4),
            "change_percent":round(float(close.pct_change().iloc[-1]*100),2),
            "market_summary":{
                "return_1m":round(float((close.iloc[-1]/close.iloc[-22]-1)*100),2),
                "return_1y":round(float((close.iloc[-1]/close.iloc[-253]-1)*100),2) if len(close)>253 else None,
                "annualized_volatility":round(annual_vol,2),
                "max_drawdown":round(float(drawdown.min()*100),2),
            },
            "technicals":{
                "rsi_14":round(rsi,2),
                "sma_20":round(float(close.rolling(20).mean().iloc[-1]),4),
                "sma_50":round(float(close.rolling(50).mean().iloc[-1]),4),
                "sma_200":round(float(close.rolling(200).mean().iloc[-1]),4) if len(close)>=200 else None,
                "macd":round(float(macd.iloc[-1]),4),
                "macd_signal":round(float(macd.ewm(span=9).mean().iloc[-1]),4),
                "bollinger_upper":round(float((middle+2*deviation).iloc[-1]),4),
                "bollinger_lower":round(float((middle-2*deviation).iloc[-1]),4),
            },
            "fundamentals":{
                "market_cap":val("marketCap"),"trailing_pe":val("trailingPE"),
                "forward_pe":val("forwardPE"),"price_to_book":val("priceToBook"),
                "eps":val("trailingEps"),"revenue":val("totalRevenue"),
                "profit_margin":val("profitMargins"),"debt_to_equity":val("debtToEquity"),
                "return_on_equity":val("returnOnEquity"),"dividend_yield":val("dividendYield"),
                "sector":info.get("sector"),"industry":info.get("industry"),
            },
            "model":{
                "arima_order":list(full_order),
                "adf_p_value":round(float(adfuller(returns)[1]),6),
                "observations":len(returns),
                "validation_observations":len(actual_returns),
                "metrics":metrics,
            },
            "forecast":{
                "horizon":horizon,
                "dates":[date.strftime("%Y-%m-%d") for date in forecast_dates],
                "arima":[round(value,4) for value in arima_path],
                "hybrid":[round(value,4) for value in forecast_path],
                "lower":[round(float(value),4) for value in lower],
                "upper":[round(float(value),4) for value in upper],
                "expected_change_percent":round((forecast_path[-1]/float(close.iloc[-1])-1)*100,2),
            },
            "history":{
                "dates":[date.strftime("%Y-%m-%d") for date in chart.index],
                "close":[round(float(value),4) for value in chart["Close"]],
            },
        }
    except AnalysisError:
        raise
    except Exception as exc:
        raise AnalysisError(f"Analysis failed: {str(exc)[:180]}") from exc
