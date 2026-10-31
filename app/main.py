from pathlib import Path
from fastapi import FastAPI,HTTPException,Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from .analyzer import analyze_ticker
from .errors import AnalysisError
BASE=Path(__file__).resolve().parent
app=FastAPI(title="Stock Analyser",version="1.0.0")
app.mount("/static",StaticFiles(directory=BASE/"static"),name="static")
@app.get("/",include_in_schema=False)
def home(): return FileResponse(BASE/"static"/"index.html")
@app.get("/api/health")
def health(): return {"status":"ok"}
@app.get("/api/analyze/{ticker}")
def analyze(ticker:str,period:str=Query("5y",pattern="^(1y|2y|5y|10y|max)$"),horizon:int=Query(30,ge=1,le=60)):
    try: return analyze_ticker(ticker,period,horizon)
    except AnalysisError as e: raise HTTPException(422,str(e)) from e
    except Exception as e: raise HTTPException(500,"Unexpected analysis error") from e
