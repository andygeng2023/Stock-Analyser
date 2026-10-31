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
async function requestAnalysis(ticker,period,horizon,mode="analysis",hardRescan=false){
 const payload=mode==="scan"?{mode:"scan",source:$("scan-source").value,hard_rescan:hardRescan}:{ticker,period,horizon};
 const r=await fetch(api("request-analysis"),{method:"POST",headers:headers(),body:JSON.stringify(payload)});
 const d=await r.json();if(!r.ok)throw Error(d.error||"Could not start analysis.");return d;
}
function updateProgress(prefix,d){
 const wrap=$(prefix+"-progress");wrap.hidden=false;
 const value=Math.max(0,Math.min(100,Number(d.progress)||0));
 $(prefix+"-progress-fill").style.width=value+"%";
 $(prefix+"-progress-percent").textContent=value+"%";
 $(prefix+"-progress-label").textContent=d.status==="queued"?"Queued":d.status==="completed"?"Complete":d.status==="failed"?"Failed":"Processing";
 $(prefix+"-progress-stage").textContent=d.stage|| (d.status==="queued"?"Waiting for a worker…":"Working…");
}
async function waitForResult(id,statusElement=$("status"),prefix="search"){
 const started=Date.now();
 while(Date.now()-started<15*60*1000){
  const r=await fetch(api("analysis-status")+"?id="+encodeURIComponent(id),{headers:{"apikey":config.supabasePublishableKey}});
  const d=await r.json();if(!r.ok)throw Error(d.error||"Could not retrieve analysis status.");
  updateProgress(prefix,d);
  if(d.status==="completed")return d.result;if(d.status==="failed")throw Error(d.error||"The analysis failed.");
  statusElement.textContent=d.status==="running"?"The worker is processing this job…":"Queued; waiting for the shared GitHub Actions worker…";await wait(2500);
 }
 throw Error("This analysis is taking longer than expected. Its job may still finish; try again later.");
}
$("search").onsubmit=async e=>{
 e.preventDefault();if(!config.supabaseUrl||!config.supabasePublishableKey){setStatus("Supabase is not configured. Add the project URL and publishable key to GitHub Actions variables.");return;}
 $("submit").disabled=true;$("hard-rescan-search").disabled=true;$("results").hidden=true;
 try{setStatus("Creating analysis request…");const request=await requestAnalysis($("ticker").value.trim().toUpperCase(),$("period").value,Number($("horizon").value),"analysis",e.submitter?.id==="hard-rescan-search");$("search-progress").hidden=false;let d;if(request.status==="completed"&&request.cached){const response=await fetch(api("analysis-status")+"?id="+encodeURIComponent(request.id),{headers:{"apikey":config.supabasePublishableKey}});const data=await response.json();if(!response.ok)throw Error(data.error||"Could not retrieve cached analysis.");d=data.result;updateProgress("search",{status:"completed",progress:100,stage:"Shared cached analysis · "+new Date(request.cache_created_at).toLocaleString()});}else{d=await waitForResult(request.id,$("status"),"search");}render(d);$("results").hidden=false;setStatus("Analysis complete · "+d.as_of);}
 catch(err){setStatus(err.message);}finally{$("submit").disabled=false;$("hard-rescan-search").disabled=false;}
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

function switchTab(tab){
 const scanning=tab==="scan";
 $("search-screen").hidden=scanning;
 $("scan-screen").hidden=!scanning;
 $("nav-search").classList.toggle("active",!scanning);
 $("nav-scan").classList.toggle("active",scanning);
 if(scanning){$("nav-scan").setAttribute("aria-current","page");$("nav-search").removeAttribute("aria-current");}
 else{$("nav-search").setAttribute("aria-current","page");$("nav-scan").removeAttribute("aria-current");}
 window.scrollTo({top:0,behavior:"instant"});
}
$("nav-search").addEventListener("click",()=>switchTab("search"));
$("nav-scan").addEventListener("click",()=>switchTab("scan"));

function renderScan(data){
 const results=data.results||[];
 $("scan-meta").textContent=`Universe: ${fmt(data.universe_size,0)} stocks · ${fmt(data.eligible_after_fast_filter,0)} passed the fast filter · ${fmt(data.arima_svr_refined,0)} refined with ARIMA–SVR · ${results.length} ranked results`;
 $("scan-list").innerHTML=results.map((item,index)=>`
  <article class="scan-result">
   <div><h3>${index+1}. ${esc(item.company)} <span class="muted">(${esc(item.ticker)})</span></h3>
   <p>${esc(item.exchange||"Listed equity")} · Price ${esc(cash(item.price,item.currency))} · Daily move ${esc(pct(item.change_percent))}<br>
   Validation directional accuracy: ${esc(fmt(item.directional_accuracy))}%</p></div>
   <div class="scan-return"><strong>${esc(pct(item.expected_change_percent))}</strong><small>30-day model estimate</small>
   <button type="button" data-ticker="${esc(item.ticker)}">Detailed analysis</button></div>
  </article>`).join("");
 $("scan-results").hidden=results.length===0;
 $("scan-list").querySelectorAll("[data-ticker]").forEach(button=>{
  button.addEventListener("click",()=>{
   $("ticker").value=button.dataset.ticker;
   switchTab("search");
   $("search").requestSubmit();
  });
 });
 if(!results.length)$("scan-status").textContent="The scan completed but could not produce ten valid refinements. Try again later.";
}
async function startScan(hard=false){
 if(!config.supabaseUrl||!config.supabasePublishableKey){$("scan-status").textContent="Supabase is not configured. Add the project URL and publishable key to GitHub Actions variables.";return;}
 $("start-scan").disabled=true;$("hard-rescan").disabled=true;
 try{
  $("scan-status").textContent=hard?"Requesting a fresh market scan…":"Checking the shared eight-hour cache…";
  const request=await requestAnalysis(null,null,null,"scan",hard);
  $("scan-progress").hidden=false;
  let result;
  if(request.status==="completed"&&request.cached){
   const response=await fetch(api("analysis-status")+"?id="+encodeURIComponent(request.id),{headers:{"apikey":config.supabasePublishableKey}});
   const data=await response.json();if(!response.ok)throw Error(data.error||"Could not retrieve cached scan.");
   result=data.result;updateProgress("scan",{status:"completed",progress:100,stage:"Shared cached result · generated "+new Date(request.cache_created_at).toLocaleString()});
   $("scan-status").textContent="Loaded shared scan from cache. No new scan was run.";
  }else{
   $("scan-status").textContent=request.reused?"A scan is already running. Joining its progress…":"Scan queued. Other visitors can use the last completed cache while this runs.";
   result=await waitForResult(request.id,$("scan-status"),"scan");
   $("scan-status").textContent="Market scan complete · "+(result.as_of||"");
  }
  renderScan(result);
 }catch(error){$("scan-status").textContent=error.message;}
 finally{$("start-scan").disabled=false;$("hard-rescan").disabled=false;}
}
$("start-scan").addEventListener("click",()=>startScan(false));
$("hard-rescan").addEventListener("click",()=>startScan(true));
\n$("hard-rescan-search").addEventListener("click",()=>$("search").requestSubmit({submitter:$("hard-rescan-search")}));\n