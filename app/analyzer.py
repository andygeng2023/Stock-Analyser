import warnings

import numpy as np
import pandas as pd
import yfinance as yf
from statsmodels.tools.sm_exceptions import ConvergenceWarning
from statsmodels.tsa.arima.model import ARIMA
from statsmodels.tsa.stattools import adfuller
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC, SVR
from sklearn.metrics import mean_absolute_error, mean_squared_error, accuracy_score
from xgboost import XGBRegressor
from .errors import AnalysisError
from .ensemble import build_regressors, build_hybrid_predictions, score_ensemble, combine_forecasts

ORDERS = [(1,0,0),(0,0,1),(1,0,1),(2,0,1),(2,0,2)]

def _select_order(series):
    candidates = []
    for order in ORDERS:
        try:
            # Use a numeric index: Yahoo Finance DatetimeIndex values often have
            # no fixed frequency, which prevents statsmodels append() from
            # extending the fitted model during one-step-ahead validation.
            with warnings.catch_warnings(record=True) as fit_warnings:
                warnings.simplefilter("always")
                fitted = ARIMA(
                    np.asarray(series, dtype=float),
                    order=order,
                    enforce_stationarity=False,
                    enforce_invertibility=False,
                ).fit()
            aic = float(fitted.aic)
            if not np.isfinite(aic):
                continue
            retvals = getattr(fitted, "mle_retvals", None)
            converged = retvals.get("converged") if isinstance(retvals, dict) else None
            if converged is None:
                converged = not any(
                    issubclass(item.category, ConvergenceWarning)
                    for item in fit_warnings
                )
            candidates.append((bool(converged), aic, order, fitted))
        except Exception:
            continue

    if not candidates:
        raise AnalysisError("ARIMA fitting failed.")

    # Prefer a genuinely converged fit, even when a failed optimizer happened
    # to report a numerically smaller AIC. Only use a non-converged fit when
    # every candidate failed to converge.
    converged_candidates = [item for item in candidates if item[0]]
    if converged_candidates:
        selected = min(converged_candidates, key=lambda item: item[1])
    else:
        warnings.warn(
            "No ARIMA candidate converged; using the lowest-AIC finite fallback.",
            RuntimeWarning,
            stacklevel=2,
        )
        selected = min(candidates, key=lambda item: item[1])

    _, _, order, fitted = selected
    return order, fitted

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

def _aligned_target_dates(validation_features, feature_dates, target_dates):
    """Map surviving feature rows to the next-session dates they predict."""
    mapping = pd.Series(
        pd.Index(target_dates).to_numpy(),
        index=pd.Index(feature_dates),
    )
    aligned = mapping.reindex(pd.Index(validation_features))
    if aligned.isna().any():
        raise AnalysisError("Could not align the chronological model validation window.")
    return pd.Index(aligned.to_numpy())


def _metrics(actual,predicted):
    return {
        "mae":round(float(mean_absolute_error(actual,predicted)),7),
        "rmse":round(float(np.sqrt(mean_squared_error(actual,predicted))),7),
        "directional_accuracy":round(float(np.mean(np.sign(actual)==np.sign(predicted))*100),2),
    }

def analyze_ticker(ticker,period="5y",horizon=30,progress_callback=None,learning_state=None,model_profile="preview"):
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
        next_return=returns.reindex(close.index).shift(-1)
        direction=pd.Series(np.where(next_return>=0,1,-1),index=close.index,dtype=float).where(next_return.notna())
        data=features.assign(target_residual=target,target_return=next_return,target_direction=direction).replace([np.inf,-np.inf],np.nan).dropna()
        feature_dates=returns.index[split-1:-1]
        if len(feature_dates) != len(test_returns):
            raise AnalysisError("Could not map validation features to next-session targets.")
        test_data=data.reindex(feature_dates).dropna()
        if len(test_data) < 15:
            raise AnalysisError("Not enough clean observations for chronological validation.")
        validation_dates = _aligned_target_dates(
            test_data.index,
            feature_dates,
            test_returns.index,
        )
        train_data=data.loc[data.index < returns.index[split-1]]
        feature_columns=features.columns.tolist()
        if len(train_data)<40:
            raise AnalysisError("Not enough clean observations to train the hybrid models.")

        def make_svr():
            return make_pipeline(StandardScaler(),SVR(kernel="rbf",C=4.0,epsilon=0.0005))
        def make_svc():
            return make_pipeline(StandardScaler(),SVC(C=1.0,kernel="rbf",class_weight="balanced"))

        x_train=train_data[feature_columns]
        svr_residual_validation=make_svr().fit(x_train,train_data["target_residual"])
        svc_validation=make_svc().fit(x_train,train_data["target_direction"].astype(int))
        predicted_residuals=svr_residual_validation.predict(test_data[feature_columns])
        predicted_direction=svc_validation.predict(test_data[feature_columns])
        actual_returns=returns.reindex(validation_dates).to_numpy(dtype=float)
        actual_residuals=residuals.reindex(validation_dates).to_numpy(dtype=float)
        predicted_arima=pd.Series(
            np.asarray(arima_predictions,dtype=float),
            index=test_returns.index,
        ).reindex(validation_dates).to_numpy(dtype=float)

        # Train a diverse set of models on the same causal feature window.
        # Each candidate is judged independently on the untouched chronological holdout.
        model_factories=build_regressors(profile=model_profile)
        candidate_predictions={"arima":predicted_arima}
        validation_models={}
        model_fit_errors={}
        for model_name,factory in model_factories.items():
            try:
                fitted=factory().fit(x_train,train_data["target_return"])
                values=np.asarray(fitted.predict(test_data[feature_columns]),dtype=float).reshape(-1)
                if len(values)!=len(actual_returns) or not np.isfinite(values).all():
                    raise ValueError("Model returned non-finite or misaligned validation predictions.")
                validation_models[model_name]=fitted
                candidate_predictions[model_name]=values
            except Exception as model_error:
                model_fit_errors[model_name]=str(model_error)[:180]

        # FullIndex uses 15 original estimators, ten first-order hybrids,
        # and three hybrids-of-hybrids. The adaptive primary hybrid scores all
        # available candidates on the same chronological holdout.
        hybrid_predictions = build_hybrid_predictions(candidate_predictions) if model_profile == "full" else {}
        candidate_predictions.update(hybrid_predictions)
        ensemble_predictions,ensemble_weights,model_assessment,baseline_rmse=score_ensemble(
            candidate_predictions,actual_returns,prior_state=learning_state
        )
        predicted_svr=candidate_predictions.get("svr_rbf",predicted_arima)
        predicted_xgb=candidate_predictions.get("xgboost",predicted_arima)
        svr_hybrid=predicted_arima+predicted_residuals
        arima_xgb_hybrid=0.5*predicted_arima+0.5*predicted_xgb
        svr_xgb_hybrid=0.5*predicted_svr+0.5*predicted_xgb
        all_direct_predictions=np.column_stack(list(candidate_predictions.values()))
        all_model_hybrid=np.mean(all_direct_predictions,axis=1)

        individual_metrics={
            name:_metrics(actual_returns,values)
            for name,values in candidate_predictions.items()
        }
        ensemble_metrics=_metrics(actual_returns,ensemble_predictions)
        metrics={
            "arima":individual_metrics.get("arima",_metrics(actual_returns,predicted_arima)),
            "svr_residual":_metrics(actual_residuals,predicted_residuals),
            "svm_residual":_metrics(actual_residuals,predicted_residuals),
            "svr":individual_metrics.get("svr_rbf",_metrics(actual_returns,predicted_svr)),
            "xgboost":individual_metrics.get("xgboost",_metrics(actual_returns,predicted_xgb)),
            "arima_svr":_metrics(actual_returns,svr_hybrid),
            "arima_xgboost":_metrics(actual_returns,arima_xgb_hybrid),
            "svr_xgboost":_metrics(actual_returns,svr_xgb_hybrid),
            "all_model_hybrid":_metrics(actual_returns,all_model_hybrid),
            "ensemble":ensemble_metrics,
            "hybrid":ensemble_metrics,
            "primary_hybrid":ensemble_metrics,
            "models":individual_metrics,
            "model_assessment":model_assessment,
            "svm_directional_accuracy":round(float(accuracy_score(
                np.where(actual_returns>=0,1,-1),predicted_direction
            )*100),2),
            "backtest":{
                "method":"chronological one-step-ahead holdout with train-only fitting",
                "prediction_target":"next_trading_day_direction",
                "forecast_horizon_days":int(horizon),
                "observations":int(len(actual_returns)),
                "start":str(validation_dates[0].date()),
                "end":str(validation_dates[-1].date()),
                "test_accuracy":ensemble_metrics["directional_accuracy"],
                "accuracy_target_percent":70,
                "accuracy_target_met":bool(ensemble_metrics["directional_accuracy"] >= 70.0),
                "ensemble":ensemble_metrics,
                "zero_return_baseline_rmse":round(float(baseline_rmse),7),
            },
        }

        learning_state_out={
            "version":1,
            "analyses_seen":int((learning_state or {}).get("analyses_seen",0) or 0),
            "training_observations":int(len(train_data)),
            "models":{
                name:{
                    "score":record["score"],
                    "directional_accuracy":record["directional_accuracy"],
                    "rmse":record["rmse"],
                    "eligible":record["eligible"],
                }
                for name,record in model_assessment.items()
            },
        }

        if progress_callback: progress_callback(65, "Retraining adaptive ensemble", "Refitting eligible models on the complete available history.")
        # Refit the selected ensemble members on the newest full history for forecasting.
        full_order,full_arima=_select_order(returns)
        full_residuals=pd.Series(np.asarray(full_arima.resid,dtype=float),index=returns.index)
        full_features=_feature_frame(close,volume,returns,full_residuals)
        full_target=full_residuals.reindex(close.index).shift(-1)
        full_next_return=returns.reindex(close.index).shift(-1)
        full_direction=pd.Series(np.where(full_next_return>=0,1,-1),index=close.index,dtype=float).where(full_next_return.notna())
        full_data=full_features.assign(target_residual=full_target,target_return=full_next_return,target_direction=full_direction).replace([np.inf,-np.inf],np.nan).dropna()
        if len(full_data)<45:
            raise AnalysisError("Not enough clean observations for the final hybrid models.")
        full_columns=full_features.columns.tolist()
        full_models={}
        full_fit_errors={}
        # Refit every base estimator, not only those individually selected
        # by the primary hybrid: first- and second-layer hybrids need their
        # constituent forecasts at every future step.
        for model_name,factory in model_factories.items():
            try:
                full_models[model_name]=factory().fit(full_data[full_columns],full_data["target_return"])
            except Exception as model_error:
                full_fit_errors[model_name]=str(model_error)[:180]

        # Keep the residual-correction and direction models as separately reported
        # diagnostics; the actual forecast blend is driven by adaptive member weights.
        svr_residual=make_svr().fit(full_data[full_columns],full_data["target_residual"])
        svc=make_svc().fit(full_data[full_columns],full_data["target_direction"].astype(int))
        if not full_models and "arima" not in ensemble_weights:
            raise AnalysisError("No eligible ensemble model could be refitted.")
        if progress_callback: progress_callback(80, "Generating forecast", "Calculating the requested forecast horizon.")
        base=np.asarray(full_arima.forecast(horizon),dtype=float)
        recent=list(returns.iloc[-20:].to_numpy(dtype=float))
        errors=list(full_residuals.iloc[-3:].to_numpy(dtype=float))
        last=float(close.iloc[-1])
        forecast_path=[]; arima_path=[]; arima_svr_price_path=[]; arima_xgb_price_path=[]; svr_xgb_price_path=[]; all_model_hybrid_price_path=[]; svr_direct_price_path=[]; xgb_price_path=[]; lower=[]; upper=[]; xgb_path=[]; svr_path=[]; svr_direct_path=[]; svm_direction_path=[]
        svr_price=float(close.iloc[-1]); svr_direct_price=float(close.iloc[-1]); xgb_price=float(close.iloc[-1]); arima_xgb_price=float(close.iloc[-1]); svr_xgb_price=float(close.iloc[-1]); all_model_price=float(close.iloc[-1])
        sigma=float(np.nanstd(full_residuals))
        rsi_now=float(full_features["rsi"].iloc[-1])
        macd_now=float(full_features["macd"].iloc[-1])
        volume_change=float(full_features["volume_change"].iloc[-1])
        forecast_rejection_counts={}
        forecast_member_counts=[]
        component_price_paths={name:[] for name in ensemble_weights}
        component_prices={name:float(close.iloc[-1]) for name in ensemble_weights}
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
            row_frame=pd.DataFrame([row],columns=full_columns)
            correction=float(svr_residual.predict(row_frame)[0])
            svm_direction=int(svc.predict(row_frame)[0])
            arima_return=float(base[i])
            candidate_returns={"arima":arima_return}
            for model_name,model in full_models.items():
                try:
                    value=float(np.asarray(model.predict(row_frame),dtype=float).reshape(-1)[0])
                    if np.isfinite(value):
                        candidate_returns[model_name]=value
                except Exception:
                    continue
            if model_profile == "full":
                candidate_returns.update(build_hybrid_predictions(candidate_returns))

            available_weights={name:ensemble_weights[name] for name in candidate_returns if name in ensemble_weights}
            if not available_weights:
                # Last-resort continuity path if all selected ML estimators fail at forecast time.
                available_weights={"arima":1.0}
                candidate_returns["arima"]=arima_return
            next_return,active_members,rejected_members=combine_forecasts(
                candidate_returns,
                available_weights,
                anomaly_floor=max(float(np.std(recent[-20:]))*0.15,0.0005),
            )
            for model_name in rejected_members:
                forecast_rejection_counts[model_name]=forecast_rejection_counts.get(model_name,0)+1
            forecast_member_counts.append(len(active_members))
            active_set=set(active_members)
            for model_name in ensemble_weights:
                value=candidate_returns.get(model_name)
                if value is not None and model_name in active_set:
                    component_prices[model_name]*=float(np.exp(value))
                    component_price_paths[model_name].append(round(component_prices[model_name],4))
                else:
                    # Keep every model series aligned to forecast dates. Null
                    # marks a step where the adaptive ensemble rejected that model.
                    component_price_paths[model_name].append(None)

            # Compatibility component paths remain available to existing charts.
            svr_return=float(arima_return+correction)
            svr_direct_return=float(candidate_returns.get("svr_rbf",next_return))
            xgb_return=float(candidate_returns.get("xgboost",next_return))
            arima_xgb_return=0.5*arima_return+0.5*xgb_return
            svr_xgb_return=0.5*svr_direct_return+0.5*xgb_return
            all_model_return=float(np.mean(list(candidate_returns.values())))
            arima_path.append(float(close.iloc[-1])*float(np.exp(np.sum(base[:i+1]))))
            svr_path.append(svr_return)
            svr_direct_path.append(svr_direct_return)
            xgb_path.append(xgb_return)
            svr_price*=float(np.exp(svr_return))
            svr_direct_price*=float(np.exp(svr_direct_return))
            xgb_price*=float(np.exp(xgb_return))
            arima_xgb_price*=float(np.exp(arima_xgb_return))
            svr_xgb_price*=float(np.exp(svr_xgb_return))
            all_model_price*=float(np.exp(all_model_return))
            arima_svr_price_path.append(svr_price)
            svr_direct_price_path.append(svr_direct_price)
            arima_xgb_price_path.append(arima_xgb_price)
            svr_xgb_price_path.append(svr_xgb_price)
            all_model_hybrid_price_path.append(all_model_price)
            xgb_price_path.append(xgb_price)
            svm_direction_path.append("up" if svm_direction>0 else "down")
            last*=float(np.exp(next_return))
            forecast_path.append(last)
            band=1.96*sigma*np.sqrt(i+1)
            lower.append(last*float(np.exp(-band)))
            upper.append(last*float(np.exp(band)))
            recent.append(next_return)
            errors.append(correction)

        ensemble_report={
            "method":"adaptive reliability-weighted robust primary hybrid",
            "architecture":{
                "original_models":len(model_factories) if model_profile == "full" else len(model_factories),
                "first_order_hybrids":10 if model_profile == "full" else 0,
                "hybrids_of_hybrids":3 if model_profile == "full" else 0,
                "primary_hybrid":1,
                "primary_hybrid_candidates":len(model_assessment),
            },
            "candidate_count":len(model_assessment),
            "active_models":list(ensemble_weights),
            "weights":{name:round(float(weight),5) for name,weight in ensemble_weights.items()},
            "rejected_models":{
                name:record["rejection_reason"]
                for name,record in model_assessment.items()
                if not record["eligible"]
            },
            "fallback_models":[
                name for name,record in model_assessment.items() if record.get("fallback")
            ],
            "validation_baseline_rmse":round(float(baseline_rmse),7),
            "forecast_dynamic_rejections":forecast_rejection_counts,
            "average_active_models_per_step":round(float(np.mean(forecast_member_counts)),2) if forecast_member_counts else 0,
            "validation_fit_failures":model_fit_errors,
            "full_refit_failures":full_fit_errors,
        }
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
        # Keep indexed JSON compact. Model fitting above still uses all available rows.
        max_chart_points = 480 if model_profile == "full" else 360
        if len(chart) > max_chart_points:
            chart = chart.iloc[np.linspace(0, len(chart) - 1, max_chart_points, dtype=int)]
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
                "model_version":"adaptive-full-ensemble-v3" if model_profile == "full" else "adaptive-ensemble-v4",
                "model_profile":model_profile,
                "accuracy_target_percent":70,
                "model_family":f"ARIMA + {len(model_factories)}-model adaptive ML ensemble" + (" · extended history" if model_profile == "full" else ""),
                "ensemble":ensemble_report,
                "learning_state":learning_state_out,
                "arima_order":list(full_order),
                "adf_p_value":round(float(adfuller(returns)[1]),6),
                "observations":len(returns),
                "validation_observations":len(actual_returns),
                "metrics":metrics,
            },
            "forecast":{
                "horizon":horizon,
                "dates":[date.strftime("%Y-%m-%d") for date in forecast_dates],
                "components":component_price_paths,
                "arima":[round(value,4) for value in arima_path],
                "arima_svr":[round(float(value),4) for value in arima_svr_price_path],
                "svr":[round(float(value),4) for value in svr_direct_price_path],
                "xgboost":[round(float(value),4) for value in xgb_price_path],
                "arima_xgboost":[round(float(value),4) for value in arima_xgb_price_path],
                "svr_xgboost":[round(float(value),4) for value in svr_xgb_price_path],
                "all_model_hybrid":[round(float(value),4) for value in all_model_hybrid_price_path],
                "arima_svr_return":[round(float(value),6) for value in svr_path],
                "svr_return":[round(float(value),6) for value in svr_direct_path],
                "xgboost_return":[round(float(value),6) for value in xgb_path],
                "svm_direction":svm_direction_path,
                "hybrid":[round(value,4) for value in forecast_path],
                "lower":[round(float(value),4) for value in lower],
                "upper":[round(float(value),4) for value in upper],
                "expected_change_percent":round((forecast_path[-1]/float(close.iloc[-1])-1)*100,2),
            },
            "history":{
                "sampled":len(chart) < len(history),
                "source_observations":int(len(history)),
                "dates":[date.strftime("%Y-%m-%d") for date in chart.index],
                "close":[round(float(value),4) for value in chart["Close"]],
            },
        }
    except AnalysisError:
        raise
    except Exception as exc:
        raise AnalysisError(f"Analysis failed: {str(exc)[:180]}") from exc
