const $=id=>document.getElementById(id),config=window.STOCK_ANALYSER_CONFIG||{};
const fmt=(v,d=2)=>v==null?"—":Number(v).toLocaleString(undefined,{maximumFractionDigits:d});
const pct=v=>v==null?"—":(v>0?"+":"")+fmt(v)+"%";
const cash=(v,c)=>v==null?"—":new Intl.NumberFormat(undefined,{style:"currency",currency:c||"USD",maximumFractionDigits:2}).format(v);
const esc=s=>String(s??"—").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const api=name=>config.supabaseUrl.replace(/\/$/,"")+"/functions/v1/"+name;
const headers=()=>({"Content-Type":"application/json","apikey":config.supabasePublishableKey});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function rows(obj){return Object.entries(obj).map(([k,v])=>'<div class="row"><span>'+esc(k.replaceAll("_"," "))+'</span><strong>'+esc(v==null?"—":v)+'</strong></div>').join("");}
function setStatus(s){$("status").textContent=s;}
async function requestAnalysis(ticker,period,horizon){
 const r=await fetch(api("request-analysis"),{method:"POST",headers:headers(),body:JSON.stringify({ticker,period,horizon})});
 const d=await r.json();if(!r.ok)throw Error(d.error||"Could not start analysis.");return d.id;
}
async function waitForResult(id){
 const started=Date.now();
 while(Date.now()-started<15*60*1000){
  const r=await fetch(api("analysis-status")+"?id="+encodeURIComponent(id),{headers:{"apikey":config.supabasePublishableKey}});
  const d=await r.json();if(!r.ok)throw Error(d.error||"Could not retrieve analysis status.");
  if(d.status==="completed")return d.result;if(d.status==="failed")throw Error(d.error||"The analysis failed.");
  setStatus(d.status==="running"?"Analysis is running on the Python worker…":"Analysis is queued; waiting for a GitHub Actions runner…");await wait(2500);
 }
 throw Error("This analysis is taking longer than expected. Its job may still finish; try again later.");
}
$("search").onsubmit=async e=>{
 e.preventDefault();if(!config.supabaseUrl||!config.supabasePublishableKey){setStatus("Supabase is not configured. Add the project URL and publishable key to GitHub Actions variables.");return;}
 $("submit").disabled=true;$("results").hidden=true;
 try{setStatus("Creating analysis request…");const id=await requestAnalysis($("ticker").value.trim().toUpperCase(),$("period").value,Number($("horizon").value));const d=await waitForResult(id);render(d);$("results").hidden=false;setStatus("Analysis complete · "+d.as_of);}
 catch(err){setStatus(err.message);}finally{$("submit").disabled=false;}
};
function render(d){
 const c=d.currency||"USD";$("symbol").textContent=d.ticker+" · "+(d.exchange||"");$("name").textContent=d.company||d.ticker;$("price").textContent=cash(d.price,c);$("change").textContent=pct(d.change_percent);
 $("summary").innerHTML=[["1-month return",pct(d.market_summary.return_1m)],["1-year return",pct(d.market_summary.return_1y)],["Annual volatility",pct(d.market_summary.annualized_volatility)],["Maximum drawdown",pct(d.market_summary.max_drawdown)]].map(([a,b])=>'<div class="card"><small>'+esc(a)+'</small><strong>'+esc(b)+'</strong></div>').join("");
 $("technicals").innerHTML=rows(Object.fromEntries(Object.entries(d.technicals).map(([k,v])=>[k,v==null?null:fmt(v,4)])));$("fundamentals").innerHTML=rows(d.fundamentals);
 const f=d.forecast;$("forecast-summary").innerHTML=[["Expected change",pct(f.expected_change_percent)],["Horizon",f.horizon+" trading days"],["ARIMA order",d.model.arima_order.join(", ")]].map(([a,b])=>'<div class="card"><small>'+esc(a)+'</small><strong>'+esc(b)+'</strong></div>').join("");
 $("metrics").innerHTML='<div class="table-wrap"><table><thead><tr><th>Model</th><th>MAE</th><th>RMSE</th><th>Directional accuracy</th></tr></thead><tbody>'+Object.entries(d.model.metrics).map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+fmt(v.mae,6)+'</td><td>'+fmt(v.rmse,6)+'</td><td>'+fmt(v.directional_accuracy)+'%</td></tr>').join("")+'</tbody></table></div>';
 $("model-note").textContent="ARIMA order: "+d.model.arima_order.join(", ")+" · ADF p-value: "+fmt(d.model.adf_p_value,6)+" · observations: "+d.model.observations;
 const layout={paper_bgcolor:"transparent",plot_bgcolor:"transparent",font:{color:"#aab8ce"},margin:{l:55,r:20,t:15,b:40},xaxis:{gridcolor:"#263650"},yaxis:{gridcolor:"#263650"},hovermode:"x unified"};
 Plotly.react("history",[{x:d.history.dates,y:d.history.close,type:"scatter",mode:"lines",line:{color:"#8aa5ff",width:2},name:"Adjusted close"}],layout,{responsive:true,displayModeBar:false});
 Plotly.react("forecast",[{x:d.history.dates.slice(-100),y:d.history.close.slice(-100),name:"History",type:"scatter",mode:"lines",line:{color:"#8aa5ff"}},{x:f.dates,y:f.hybrid,name:"ARIMA + SVR",type:"scatter",mode:"lines",line:{color:"#39c99a",width:2}},{x:f.dates,y:f.arima,name:"ARIMA",type:"scatter",mode:"lines",line:{color:"#e9b86b",dash:"dot"}},{x:f.dates,y:f.upper,type:"scatter",mode:"lines",line:{width:0},showlegend:false},{x:f.dates,y:f.lower,type:"scatter",mode:"lines",line:{width:0},fill:"tonexty",fillcolor:"rgba(57,201,154,.12)",showlegend:false}],layout,{responsive:true,displayModeBar:false});
}