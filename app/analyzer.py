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

def analyze_ticker(ticker, period="5y", horizon=30):
    ticker=ticker.strip().upper()
    if not ticker or len(ticker)>20 or not all(c.isalnum() or c in ".-^=" for c in ticker): raise AnalysisError("Enter a valid ticker.")
    if period not in {"1y","2y","5y","10y","max"}: raise AnalysisError("Invalid history period.")
    if not 1<=horizon<=60: raise AnalysisError("Forecast horizon must be 1–60 trading days.")
    try:
        asset=yf.Ticker(ticker); hist=asset.history(period=period,auto_adjust=True)
        if hist.empty or len(hist)<100: raise AnalysisError("Insufficient price history. Check the ticker.")
        close=hist.Close.dropna().astype(float); volume=hist.Volume.reindex(close.index).fillna(0)
        ret=np.log(close/close.shift(1)).dropna()
        if len(ret)<90: raise AnalysisError("At least 90 daily returns are required.")
        candidates=[]
        for order in [(1,0,0),(0,0,1),(1,0,1),(2,0,1),(2,0,2)]:
            try:
                fit=ARIMA(ret,order=order,enforce_stationarity=False,enforce_invertibility=False).fit()
                candidates.append((fit.aic,order,fit))
            except Exception: pass
        if not candidates: raise AnalysisError("ARIMA fitting failed.")
        _,order,arima=min(candidates,key=lambda x:x[0])
        resid=pd.Series(np.asarray(arima.resid),index=ret.index)
        x=pd.DataFrame(index=close.index); r=ret.reindex(close.index)
        for lag in range(1,6): x[f"r{lag}"]=r.shift(lag)
        x["vol5"]=r.rolling(5).std(); x["vol20"]=r.rolling(20).std()
        delta=close.diff(); gain=delta.clip(lower=0).ewm(alpha=1/14,adjust=False).mean(); loss=(-delta.clip(upper=0)).ewm(alpha=1/14,adjust=False).mean()
        x["rsi"]=100-100/(1+gain/loss.replace(0,np.nan))
        x["macd"]=(close.ewm(span=12).mean()-close.ewm(span=26).mean())/close
        x["volume_change"]=volume.pct_change().replace([np.inf,-np.inf],np.nan).clip(-5,5)
        for lag in range(1,4): x[f"e{lag}"]=resid.reindex(close.index).shift(lag)
        target=resid.reindex(close.index).shift(-1)
        data=x.assign(target=target).replace([np.inf,-np.inf],np.nan).dropna()
        if len(data)<45: raise AnalysisError("Not enough clean observations for SVR.")
        split=int(len(data)*.8)
        def make_model(): return make_pipeline(StandardScaler(),SVR(kernel="rbf",C=10,epsilon=.001))
        # Strict chronological walk-forward validation: each prediction only sees prior rows.
        actual_returns=[]; actual_residuals=[]; pred_resid=[]; pred_arima=[]
        for i in range(split,len(data)):
            prior=data.iloc[:i]; m=make_model().fit(prior.drop(columns="target"),prior.target)
            pred_resid.append(float(m.predict(data.drop(columns="target").iloc[[i]])[0]))
            actual_residuals.append(float(data.target.iloc[i]))
            actual_returns.append(float(ret.shift(-1).loc[data.index[i]]))
            loc=ret.index.get_loc(data.index[i])
            af=ARIMA(ret.iloc[:loc],order=order,enforce_stationarity=False,enforce_invertibility=False).fit()
            pred_arima.append(float(af.forecast(1).iloc[0]))
        actual_returns=np.array(actual_returns); actual_residuals=np.array(actual_residuals); pred_resid=np.array(pred_resid); pred_arima=np.array(pred_arima)
        def metrics(y,p):
            return {"mae":round(float(mean_absolute_error(y,p)),7),"rmse":round(float(np.sqrt(mean_squared_error(y,p))),7),"directional_accuracy":round(float(np.mean(np.sign(y)==np.sign(p))*100),2)}
        metrics_out={"arima":metrics(actual_returns,pred_arima),"svm_residual":metrics(actual_residuals,pred_resid),"hybrid":metrics(actual_returns,pred_arima+pred_resid)}
        resid=pd.Series(np.asarray(arima.resid),index=ret.index)
        for lag in range(1,4): x[f"e{lag}"]=resid.reindex(close.index).shift(lag)
        target=resid.reindex(close.index).shift(-1); full=x.assign(target=target).replace([np.inf,-np.inf],np.nan).dropna()
        svr=make_model().fit(full.drop(columns="target"),full.target)
        base=np.asarray(arima.forecast(horizon)); recent=list(ret.iloc[-5:]); errors=list(resid.iloc[-3:])
        last=float(close.iloc[-1]); path=[]; baseline=[]; lower=[]; upper=[]; sigma=float(np.nanstd(resid))
        for i in range(horizon):
            row={**{f"r{j}":recent[-j] for j in range(1,6)},"vol5":float(np.std(recent[-5:])),"vol20":float(ret.tail(20).std()),"rsi":float(x.rsi.iloc[-1]),"macd":float(x.macd.iloc[-1]),"volume_change":0.0,**{f"e{j}":errors[-j] for j in range(1,4)}}
            correction=float(svr.predict(pd.DataFrame([row],columns=full.drop(columns="target").columns))[0])
            baseline.append(float(close.iloc[-1])*np.exp(np.sum(base[:i+1])))
            rr=float(base[i]+correction); last*=np.exp(rr); path.append(last)
            band=1.96*sigma*np.sqrt(i+1); lower.append(last*np.exp(-band)); upper.append(last*np.exp(band))
            recent.append(rr); errors.append(correction)
        info={}
        try: info=asset.get_info() or {}
        except Exception: pass
        def val(k):
            v=info.get(k)
            return round(float(v),4) if isinstance(v,(int,float,np.number)) and np.isfinite(v) else None
        rsi=float(x.rsi.iloc[-1]); sma=lambda n:float(close.rolling(n).mean().iloc[-1])
        e12=close.ewm(span=12).mean(); e26=close.ewm(span=26).mean(); macd=e12-e26
        mid=close.rolling(20).mean(); sd=close.rolling(20).std(); dd=close/close.cummax()-1
        annvol=float(ret.tail(252).std()*np.sqrt(252)*100)
        chart=hist.tail(500); dates=pd.bdate_range(close.index[-1]+pd.offsets.BDay(1),periods=horizon)
        return {"ticker":ticker,"company":info.get("longName") or info.get("shortName") or ticker,"exchange":info.get("exchange"),"currency":info.get("currency") or "USD","as_of":close.index[-1].strftime("%Y-%m-%d"),"price":round(float(close.iloc[-1]),4),"change_percent":round(float(close.pct_change().iloc[-1]*100),2),"market_summary":{"return_1m":round(float((close.iloc[-1]/close.iloc[-22]-1)*100),2),"return_1y":round(float((close.iloc[-1]/close.iloc[-253]-1)*100),2) if len(close)>253 else None,"annualized_volatility":round(annvol,2),"max_drawdown":round(float(dd.min()*100),2)},"technicals":{"rsi_14":round(rsi,2),"sma_20":round(sma(20),4),"sma_50":round(sma(50),4),"sma_200":round(sma(200),4) if len(close)>=200 else None,"macd":round(float(macd.iloc[-1]),4),"macd_signal":round(float(macd.ewm(span=9).mean().iloc[-1]),4),"bollinger_upper":round(float((mid+2*sd).iloc[-1]),4),"bollinger_lower":round(float((mid-2*sd).iloc[-1]),4)},"fundamentals":{"market_cap":val("marketCap"),"trailing_pe":val("trailingPE"),"forward_pe":val("forwardPE"),"price_to_book":val("priceToBook"),"eps":val("trailingEps"),"revenue":val("totalRevenue"),"profit_margin":val("profitMargins"),"debt_to_equity":val("debtToEquity"),"return_on_equity":val("returnOnEquity"),"dividend_yield":val("dividendYield"),"sector":info.get("sector"),"industry":info.get("industry")},"model":{"arima_order":list(order),"adf_p_value":round(float(adfuller(ret)[1]),6),"observations":len(ret),"metrics":metrics_out},"forecast":{"horizon":horizon,"dates":[d.strftime("%Y-%m-%d") for d in dates],"arima":[round(v,4) for v in baseline],"hybrid":[round(v,4) for v in path],"lower":[round(float(v),4) for v in lower],"upper":[round(float(v),4) for v in upper],"expected_change_percent":round((path[-1]/float(close.iloc[-1])-1)*100,2)},"history":{"dates":[d.strftime("%Y-%m-%d") for d in chart.index],"close":[round(float(v),4) for v in chart.Close]}}
    except AnalysisError: raise
    except Exception as exc: raise AnalysisError(f"Analysis failed: {str(exc)[:180]}") from exc
