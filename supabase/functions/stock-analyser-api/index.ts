import postgres from "npm:postgres@3.4.7";

function parseTidbConnection(raw: string, passwordOverride: string) {
  let dsn = String(raw || "").trim();
  if (!dsn) throw new Error("DATABASE_URL is missing.");
  dsn = dsn.replace(/^\\+psql\s+/i, "");
  if ((dsn.startsWith("'") && dsn.endsWith("'")) || (dsn.startsWith('"') && dsn.endsWith('"'))) {
    dsn = dsn.slice(1, -1);
  }
  let options: Record<string, string> = {};
  if (/^postgres(?:ql)?:\/\//i.test(dsn)) {
    const url = new URL(dsn);
    options = {
      host: url.hostname,
      port: url.port || "4000",
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      dbname: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
      sslmode: url.searchParams.get("sslmode") || "verify-full",
    };
  } else {
    for (const match of dsn.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g)) {
      options[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
    }
  }
  let database = String(options.dbname || options.database || "postgres").replace(/;$/, "");
  if (/^<db>$/i.test(database) || /^%3cdb%3e$/i.test(database)) database = "postgres";
  const sslMode = String(options.sslmode || "verify-full").toLowerCase();
  if (!options.host || !options.user) throw new Error("TiDB connection details are incomplete.");
  if (sslMode === "disable" || sslMode === "allow") throw new Error("TiDB connections must use TLS.");
  const password = passwordOverride || options.password || "";
  if (!password) throw new Error("TIDB_PASSWORD is missing.");
  return {
    host: options.host,
    port: Number(options.port || "4000"),
    username: options.user,
    password,
    database,
    ssl: { rejectUnauthorized: true },
    connect_timeout: 15,
    idle_timeout: 20,
    max: 4,
    prepare: false,
  };
}

const databaseUrl = Deno.env.get("DATABASE_URL") || "";
const tidbPassword = Deno.env.get("TIDB_PASSWORD") || "";
let sqlClient: ReturnType<typeof postgres> | null = null;
let connectionConfigError = "";
if (databaseUrl) {
  try {
    sqlClient = postgres(parseTidbConnection(databaseUrl, tidbPassword));
  } catch (error) {
    connectionConfigError = error instanceof Error ? error.message : "Invalid TiDB connection configuration.";
    console.error("TiDB connection configuration error:", connectionConfigError);
  }
}

function toPostgres(query: string) {
  const ignoreConflict = /^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(query);
  let index = 0;
  let translated = query
    .replace(/\s+COLLATE\s+NOCASE/gi, "")
    .replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO")
    .replace(/\?/g, () => "$" + (++index));
  if (ignoreConflict && !/\bON\s+CONFLICT\b/i.test(translated)) translated += " ON CONFLICT DO NOTHING";
  return translated;
}

function makeStatement(query: string, values: unknown[] = []) {
  const translated = toPostgres(query);
  const execute = async () => {
    if (!sqlClient) {
      if (connectionConfigError) throw new Error(connectionConfigError);
      if (!databaseUrl) throw new Error("DATABASE_URL is missing.");
      throw new Error("TiDB connection could not be initialised.");
    }
    return await sqlClient.unsafe(translated, values as any[]);
  };
  return {
    bind: (...bound: unknown[]) => makeStatement(query, bound),
    first: async () => {
      const rows = await execute();
      return rows[0] ?? null;
    },
    all: async () => ({ results: [...await execute()] }),
    run: async () => {
      const rows = await execute();
      return { meta: { changes: Number((rows as any).count ?? rows.length) } };
    },
  };
}

const env = { DB: { prepare: (query: string) => makeStatement(query) } };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Cache-Control": "no-store", ...extra },
});
const now = () => new Date().toISOString();
async function allowRate(env, req, bucket, limit, windowMs) {
  const ip=(req.headers.get("x-forwarded-for")||req.headers.get("x-real-ip")||"unknown").split(",")[0].trim();
  const key=await sha(bucket+":"+ip), current=Date.now(), cutoff=current-windowMs;
  const row=await env.DB.prepare("INSERT INTO api_rate_limits(bucket_key,window_start,attempts) VALUES(?,?,1) ON CONFLICT(bucket_key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN ? ELSE window_start END RETURNING attempts").bind(key,current,cutoff,cutoff,current).first();
  return Number(row?.attempts||0)<=limit;
}
const validTicker = value => /^[A-Z0-9.^=-]{1,20}$/.test(String(value || ""));
const parse = value => { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; } };
const tokenFrom = req => (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
const hex = bytes => [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2,"0")).join("");
const randomToken = () => { const b = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""); };
async function sha(value) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({name:"PBKDF2",salt:new Uint8Array(salt.match(/.{2}/g).map(x=>parseInt(x,16))),iterations:310000,hash:"SHA-256"},key,256));
}
async function authenticate(req, env) {
  const token = tokenFrom(req);
  if (!token) return null;
  const hash = await sha(token);
  return await env.DB.prepare("SELECT u.id,u.email,u.display_name,u.created_at,u.last_sign_in_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").bind(hash,now()).first();
}
async function issueSession(env,userId) {
  const token = randomToken(), created = now(), expires = new Date(Date.now()+30*86400000).toISOString();
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)").bind(await sha(token),userId,created,expires).run();
  return token;
}
function userShape(row) {
  return {id:row.id,email:row.email,created_at:row.created_at,last_sign_in_at:row.last_sign_in_at,email_confirmed_at:null,user_metadata:{display_name:row.display_name||""}};
}
async function authRoutes(req,env,url) {
  const route=url.pathname.split("/").pop(), body=req.method==="POST"||req.method==="PATCH"?await req.json().catch(()=>({})): {};
  if(["signup","login","reset"].includes(route)) {
    const limits={signup:[5,3600000],login:[10,900000],reset:[3,3600000]};
    const [limit,windowMs]=limits[route];
    if(!await allowRate(env,req,"auth-"+route,limit,windowMs))return json({error:"Too many attempts. Please wait before trying again."},429);
  }
  if(route==="signup" && req.method==="POST") {
    const email=String(body.email||"").trim().toLowerCase(), password=String(body.password||"");
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8||password.length>256) return json({error:"Enter a valid email and a password of at least 8 characters."},400);
    const salt=hex(crypto.getRandomValues(new Uint8Array(16))), hash=await passwordHash(password,salt), id=crypto.randomUUID(), created=now();
    try { await env.DB.prepare("INSERT INTO users(id,email,password_hash,password_salt,created_at,last_sign_in_at) VALUES(?,?,?,?,?,?)").bind(id,email,hash,salt,created,created).run(); }
    catch { return json({error:"An account with that email may already exist."},409); }
    const token=await issueSession(env,id), user={id,email,created_at:created,last_sign_in_at:created,email_confirmed_at:null,user_metadata:{display_name:""}};
    return json({user,session:{access_token:token,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+2592000,user}},201);
  }
  if(route==="login" && req.method==="POST") {
    const email=String(body.email||"").trim().toLowerCase(), password=String(body.password||"");
    const row=await env.DB.prepare("SELECT * FROM users WHERE email=? COLLATE NOCASE").bind(email).first();
    if(!row || await passwordHash(password,row.password_salt)!==row.password_hash) return json({error:"Email or password is incorrect."},401);
    const signed=now(); await env.DB.prepare("UPDATE users SET last_sign_in_at=? WHERE id=?").bind(signed,row.id).run();
    const token=await issueSession(env,row.id), user=userShape({...row,last_sign_in_at:signed});
    return json({user,session:{access_token:token,token_type:"bearer",expires_at:Math.floor(Date.now()/1000)+2592000,user}});
  }
  if(route==="me" && req.method==="GET") {
    const row=await authenticate(req,env); if(!row) return json({error:"Your session has expired. Sign in again."},401);
    return json({user:userShape(row)});
  }
  if(route==="logout" && req.method==="POST") {
    const token=tokenFrom(req); if(token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha(token)).run();
    return json({success:true});
  }
  if(route==="logout-all" && req.method==="POST") {
    const row=await authenticate(req,env); if(!row) return json({error:"Sign in again."},401);
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(row.id).run(); return json({success:true});
  }
  if(route==="logout-others" && req.method==="POST") {
    const row=await authenticate(req,env); if(!row) return json({error:"Sign in again."},401);
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").bind(row.id,await sha(tokenFrom(req))).run(); return json({success:true});
  }
  if(route==="profile" && req.method==="PATCH") {
    const row=await authenticate(req,env); if(!row) return json({error:"Sign in again."},401);
    if(body.email) return json({error:"Email changes are disabled until an email verification service is configured."},400);
    await env.DB.prepare("UPDATE users SET display_name=? WHERE id=?").bind(String(body.display_name||"").slice(0,80),row.id).run();
    const updated=await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(row.id).first(); return json({user:userShape(updated)});
  }
  if(route==="password" && req.method==="PATCH") {
    const row=await authenticate(req,env); if(!row) return json({error:"Sign in again."},401);
    const password=String(body.password||""); if(password.length<8||password.length>256) return json({error:"Password must contain at least 8 characters."},400);
    const salt=hex(crypto.getRandomValues(new Uint8Array(16))), hash=await passwordHash(password,salt);
    await env.DB.prepare("UPDATE users SET password_hash=?,password_salt=? WHERE id=?").bind(hash,salt,row.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?").bind(row.id,await sha(tokenFrom(req))).run();
    return json({success:true});
  }
  if(route==="reset" && req.method==="POST") return json({error:"Password-reset emails are not available in the zero-cost deployment. Sign in on a device where you still have access and change your password in Settings."},501);
  return json({error:"Not found."},404);
}
async function watchlist(req,env) {
  const user=await authenticate(req,env); if(!user) return json({error:"Sign in to use your watchlist."},401);
  const body=await req.json().catch(()=>({})), action=String(body.action||"list");
  if(action==="add") {
    const ticker=String(body.ticker||"").trim().toUpperCase(); if(!validTicker(ticker)) return json({error:"Enter a valid ticker."},400);
    const count=await env.DB.prepare("SELECT COUNT(*) AS n FROM watchlist_items WHERE user_id=?").bind(user.id).first();
    const existing=await env.DB.prepare("SELECT id FROM watchlist_items WHERE user_id=? AND ticker=?").bind(user.id,ticker).first();
    if(!existing && count.n>=100) return json({error:"A watchlist can contain up to 100 stocks."},409);
    await env.DB.prepare("INSERT OR IGNORE INTO watchlist_items(id,user_id,ticker,created_at) VALUES(?,?,?,?)").bind(crypto.randomUUID(),user.id,ticker,now()).run();
  } else if(action==="remove") {
    const ticker=String(body.ticker||"").trim().toUpperCase(); if(!validTicker(ticker)) return json({error:"Enter a valid ticker."},400);
    await env.DB.prepare("DELETE FROM watchlist_items WHERE user_id=? AND ticker=?").bind(user.id,ticker).run();
  } else if(action!=="list") return json({error:"Unknown watchlist action."},400);
  const items=await env.DB.prepare("SELECT ticker,created_at FROM watchlist_items WHERE user_id=? ORDER BY created_at DESC").bind(user.id).all();
  const tickers=items.results.map(x=>x.ticker);
  if(!tickers.length) return json({items:[]});
  const placeholders=tickers.map(()=>"?").join(",");
  const indexed=await env.DB.prepare("SELECT ticker,result,indexed_at FROM market_index WHERE period='5y' AND horizon=30 AND indexer='rapidIndex' AND ticker IN ("+placeholders+")").bind(...tickers).all();
  const map=new Map(indexed.results.map(row=>[row.ticker,row]));
  const cutoff=Date.now()-6*3600000;
  const stale=tickers.filter(t=>{const r=map.get(t);return !r?.indexed_at||Date.parse(r.indexed_at)<cutoff;});
  // WatchIndex is scheduled by GitHub Actions; no outbound GitHub credential is needed here.
  const compact=(raw,at)=>{const r=parse(raw);if(!r)return null;const sample=(v,n)=>{if(!Array.isArray(v))return[];const a=v.map(Number).filter(Number.isFinite);return a.length<=n?a:Array.from({length:n},(_,i)=>a[Math.round(i*(a.length-1)/(n-1))]);};return {company:r.company||r.ticker,currency:r.currency||"USD",price:r.price??null,change_percent:r.change_percent??null,as_of:r.as_of??null,indexed_at:at,history_preview:sample(r.history?.close,72),forecast_preview:sample(r.forecast?.hybrid,30),market_summary:r.market_summary||{},fundamentals:{market_cap:r.fundamentals?.market_cap??null,sector:r.fundamentals?.sector??null,industry:r.fundamentals?.industry??null,profit_margin:r.fundamentals?.profit_margin??null,return_on_equity:r.fundamentals?.return_on_equity??null},model:{metrics:{hybrid:r.model?.metrics?.hybrid||{}}},forecast:{horizon:r.forecast?.horizon||30,expected_change_percent:r.forecast?.expected_change_percent??null}};};
  return json({items:items.results.map(item=>{const row=map.get(item.ticker);return {ticker:item.ticker,added_at:item.created_at,analysis:compact(row?.result,row?.indexed_at||null),indexed_at:row?.indexed_at||null,index_fresh:Boolean(row?.indexed_at&&Date.parse(row.indexed_at)>=cutoff),awaiting_watchindex:stale.includes(item.ticker)};}),refreshing:stale.length>0});
}
async function dispatchWorkflow(env,workflow) {
  const res=await fetch("https://api.github.com/repos/andygeng2023/Stock-Analyser/actions/workflows/"+workflow+"/dispatches",{method:"POST",headers:{"Accept":"application/vnd.github+json","Authorization":"Bearer "+env.GITHUB_TOKEN,"X-GitHub-Api-Version":"2022-11-28","Content-Type":"application/json"},body:JSON.stringify({ref:"main"})});
  if(!res.ok) throw new Error("GitHub workflow dispatch failed: "+res.status);
}
async function requestAnalysis(req,env) {
  if(!await allowRate(env,req,"analysis-request",20,3600000))return json({error:"Analysis request limit reached for this connection. Please try again later."},429);
  const body=await req.json(), mode=body.mode==="scan"?"scan":"analysis", ticker=mode==="scan"?"SCAN":String(body.ticker||"").trim().toUpperCase();
  const period=mode==="scan"?"5y":String(body.period||"5y"), horizon=mode==="scan"?30:Number(body.horizon||30);
  const scanSource=mode==="scan"?String(body.source||"both").toLowerCase():"both";
  const save=mode==="scan"?"none":String(body.save_to_indexer||(period==="max"&&horizon===252?"SlowIndex":"rapidIndex"));
  if(mode==="analysis"&&!validTicker(ticker))return json({error:"Enter a valid stock ticker."},400);
  if(!["1y","2y","5y","10y","max"].includes(period)||!Number.isInteger(horizon)||horizon<1||horizon>504)return json({error:"Invalid analysis period or forecast horizon."},400);
  if(!["yfinance","nasdaq","both"].includes(scanSource)||!["rapidIndex","SlowIndex","none"].includes(save))return json({error:"Invalid analysis options."},400);
  if(body.latest_only===true) {
    const row=await env.DB.prepare("SELECT id,created_at FROM analysis_jobs WHERE job_type='scan' AND ticker='SCAN' AND period='5y' AND horizon=30 AND scan_source=? AND status='completed' AND result IS NOT NULL ORDER BY created_at DESC LIMIT 1").bind(scanSource).first();
    return row?json({id:row.id,status:"completed",ticker:"SCAN",mode,cached:true,cache_created_at:row.created_at}):json({found:false,mode,source:scanSource});
  }
  if(!body.hard_rescan && mode==="analysis" && save!=="none") {
    const age=save==="SlowIndex"?30*86400000:8*3600000, cutoff=new Date(Date.now()-age).toISOString();
    const cached=await env.DB.prepare("SELECT source_job_id,indexed_at FROM market_index WHERE ticker=? AND period=? AND horizon=? AND indexer=? AND indexed_at>=? AND source_job_id IS NOT NULL LIMIT 1").bind(ticker,period,horizon,save,cutoff).first();
    if(cached?.source_job_id)return json({id:cached.source_job_id,status:"completed",ticker,mode,cached:true,cache_source:"market_index",cache_created_at:cached.indexed_at});
  }
  if(!body.hard_rescan && (mode==="scan"||save!=="none")) {
    const age=save==="SlowIndex"?30*86400000:8*3600000, cutoff=new Date(Date.now()-age).toISOString();
    const cached=await env.DB.prepare("SELECT id,created_at FROM analysis_jobs WHERE job_type=? AND scan_source=? AND ticker=? AND period=? AND horizon=? AND save_to_indexer=? AND status='completed' AND result IS NOT NULL AND created_at>=? ORDER BY created_at DESC LIMIT 1").bind(mode,scanSource,ticker,period,horizon,save,cutoff).first();
    if(cached)return json({id:cached.id,status:"completed",ticker,mode,cached:true,cache_created_at:cached.created_at});
  }
  const active=await env.DB.prepare("SELECT id,status FROM analysis_jobs WHERE job_type=? AND scan_source=? AND ticker=? AND period=? AND horizon=? AND save_to_indexer=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").bind(mode,scanSource,ticker,period,horizon,save).first();
  if(active)return json({id:active.id,status:active.status,ticker,mode,reused:true},202);
  const queued=await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE status='queued'").first();
  if(queued.n>=100)return json({error:"The analysis queue is currently full. Please try again shortly."},503);
  const id=crypto.randomUUID(), created=now();
  await env.DB.prepare("INSERT INTO analysis_jobs(id,ticker,period,horizon,job_type,scan_source,save_to_indexer,status,client_ip_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued','public',?,?)").bind(id,ticker,period,horizon,mode,scanSource,save,created,created).run();
  // The queue worker polls on a five-minute GitHub Actions schedule. This avoids requiring a GitHub token in the public API Worker.
  return json({id,status:"queued",ticker,mode},202);
}
async function marketFeed(req,env,url) {
  const q=(url.searchParams.get("q")||"").trim().slice(0,60);
  if(q) {
    try {
      const yahoo=new URL("https://query1.finance.yahoo.com/v1/finance/search");yahoo.searchParams.set("q",q);yahoo.searchParams.set("quotesCount","12");yahoo.searchParams.set("newsCount","0");
      const res=await fetch(yahoo,{headers:{"User-Agent":"Mozilla/5.0 StockAnalyser/1.0"}});
      if(res.ok){const data=await res.json(), suggestions=(data.quotes||[]).filter(x=>x.quoteType==="EQUITY"&&x.symbol).slice(0,9).map(x=>({ticker:x.symbol,company:x.longname||x.shortname||x.symbol,exchange:x.exchDisp||x.exchange||null,type:"Stock"}));if(suggestions.length)return json({suggestions},200,{"Cache-Control":"public, max-age=60"});}
    } catch(e){console.warn("Yahoo symbol search failed",e);}
    const rows=await env.DB.prepare("SELECT ticker,result FROM market_index WHERE period='5y' AND horizon=30 AND indexer='rapidIndex' LIMIT 1500").all();
    return json({suggestions:rows.results.map(r=>{const x=parse(r.result)||{};return {ticker:r.ticker,company:x.company||r.ticker,exchange:x.exchange||null,type:"Indexed stock"};}).filter(x=>x.ticker.toLowerCase().includes(q.toLowerCase())||x.company.toLowerCase().includes(q.toLowerCase())).slice(0,9)});
  }
  const response=await env.DB.prepare("SELECT ticker,indexed_at,market_cap,avg_dollar_volume,priority,result FROM market_index WHERE period='5y' AND horizon=30 AND indexer='rapidIndex' ORDER BY indexed_at DESC LIMIT 1500").all();
  const stocks=response.results.map(row=>{const r=parse(row.result)||{},s=r.market_summary||{},f=r.fundamentals||{},m=r.model?.metrics?.backtest||{},num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d,optional=v=>v==null?null:num(v,null);
    const market_cap=num(row.market_cap||f.market_cap),avg_dollar_volume=num(row.avg_dollar_volume||s.average_dollar_volume),return_1m=num(s.return_1m),return_1y=num(s.return_1y),vol=num(s.annualized_volatility,100),draw=num(s.max_drawdown,-100),profit=num(f.profit_margin,-1),roe=num(f.return_on_equity,-1),accuracy=optional(m.test_accuracy??m.ensemble?.directional_accuracy??r.model?.metrics?.hybrid?.directional_accuracy);
    const quality=Math.max(0,Math.min(1,(return_1m+10)/40))*25+Math.max(0,Math.min(1,(roe+.1)/.5))*20+Math.max(0,Math.min(1,(profit+.05)/.25))*15+Math.max(0,Math.min(1,(70-vol)/50))*20+Math.max(0,Math.min(1,(draw+70)/70))*20;
    return {ticker:row.ticker,company:r.company||row.ticker,exchange:r.exchange||null,currency:r.currency||"USD",price:optional(r.price),change_percent:optional(r.change_percent),market_cap:market_cap||null,avg_dollar_volume:avg_dollar_volume||null,return_1m,return_1y,annualized_volatility:vol,max_drawdown:draw,profit_margin:profit,return_on_equity:roe,expected_change_percent:optional(r.forecast?.expected_change_percent),directional_accuracy:accuracy,sector:f.sector||null,industry:f.industry||null,indexed_at:row.indexed_at,quality_score:Math.round(quality*100)/100,history_preview:(r.history?.close||[]).filter((_,i,a)=>i%Math.max(1,Math.ceil(a.length/72))===0).slice(0,72),forecast_preview:r.forecast?.hybrid||[]};});
  const unique=[...new Map(stocks.map(x=>[x.ticker,x])).values()], liquid=unique.filter(s=>s.avg_dollar_volume>=2e6&&s.market_cap>=1e8), smaller=liquid.filter(s=>s.market_cap<2e9), healthy=smaller.filter(s=>s.return_1m>0&&s.profit_margin>0&&s.return_on_equity>0&&s.annualized_volatility<=70&&s.max_drawdown>=-75);
  const recommended=unique.filter(s=>s.avg_dollar_volume>=2e6&&s.market_cap>=1e8&&s.return_1m>0&&s.profit_margin>0&&s.return_on_equity>0&&s.annualized_volatility<=65&&s.max_drawdown>=-70&&s.directional_accuracy>=50).sort((a,b)=>b.quality_score-a.quality_score).slice(0,8);
  const trending=unique.filter(s=>s.return_1m>0&&s.avg_dollar_volume>=2e6).sort((a,b)=>b.return_1m-a.return_1m).slice(0,8);
  const popular=unique.filter(s=>s.market_cap>0&&s.avg_dollar_volume>0).sort((a,b)=>(Math.log10(b.market_cap)*.55+Math.log10(b.avg_dollar_volume)*.45)-(Math.log10(a.market_cap)*.55+Math.log10(a.avg_dollar_volume)*.45)).slice(0,8);
  const opportunities=healthy.sort((a,b)=>b.quality_score-a.quality_score).slice(0,8), smallerCompanies=smaller.sort((a,b)=>b.quality_score-a.quality_score).slice(0,12);
  const scan=await env.DB.prepare("SELECT created_at,result FROM analysis_jobs WHERE job_type='scan' AND status='completed' AND result IS NOT NULL ORDER BY created_at DESC LIMIT 1").first();
  const raw=parse(scan?.result), latest=raw&&Array.isArray(raw.results)?{as_of:raw.as_of||scan.created_at,created_at:scan.created_at,universe_size:raw.universe_size||null,results:raw.results.slice(0,8).map(x=>({...x,return_1m:unique.find(s=>s.ticker===x.ticker)?.return_1m??null,annualized_volatility:unique.find(s=>s.ticker===x.ticker)?.annualized_volatility??null}))}:null;
  return json({generated_at:now(),indexed_count:unique.length,small_company_count:smaller.length,quality_small_company_count:healthy.length,latest_scan:latest,recommended,trending,popular,opportunities,smaller_companies:smallerCompanies},200,{"Cache-Control":"public, max-age=60"});
}
async function stockMarketData(req,env) {
  const body=await req.json(),tickers=[...new Set((Array.isArray(body.tickers)?body.tickers:[]).map(x=>String(x).trim().toUpperCase()).filter(validTicker))].slice(0,60),mode=["indexed","quotes","history","both"].includes(body.mode)?body.mode:"both";
  const quote=async ticker=>{
    const u=new URL("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(ticker));u.searchParams.set("range","5d");u.searchParams.set("interval","1d");
    const r=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0"}});if(!r.ok)throw new Error("Yahoo quote unavailable");const d=await r.json(),x=d.chart?.result?.[0];if(!x)throw new Error("Yahoo quote unavailable");const meta=x.meta||{},price=meta.regularMarketPrice??null,prev=meta.chartPreviousClose??meta.previousClose??null;return {price,change_percent:price!=null&&prev?((price-prev)/prev)*100:null,currency:meta.currency||null,as_of:meta.regularMarketTime?new Date(meta.regularMarketTime*1000).toISOString():null};
  };
  const history=async ticker=>{
    const u=new URL("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(ticker));u.searchParams.set("range","1y");u.searchParams.set("interval","1d");
    const r=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0"}});if(!r.ok)throw new Error("Yahoo history unavailable");const d=await r.json(),x=d.chart?.result?.[0];if(!x)throw new Error("Yahoo history unavailable");const q=x.indicators?.quote?.[0],close=(q?.close||[]).filter(v=>v!=null),meta=x.meta||{};return {ticker,history_preview:close.slice(-72),price:meta.regularMarketPrice??close.at(-1)??null,change_percent:null,currency:meta.currency||null,source:"Yahoo Finance historical fallback"};
  };
  if(mode==="quotes"||mode==="history")return json({items:await Promise.all(tickers.map(async ticker=>{try{return {ticker,...(mode==="quotes"?await quote(ticker):await history(ticker))};}catch{return {ticker,price:null,history_preview:[],change_percent:null,currency:null,source:"unavailable"};}})),generated_at:now(),mode});
  const placeholders=tickers.map(()=>"?").join(",");
  const rows=tickers.length?await env.DB.prepare("SELECT ticker,result,indexed_at FROM market_index WHERE ticker IN ("+placeholders+") AND period='5y' AND horizon=30 AND indexer='rapidIndex'").bind(...tickers).all():{results:[]};
  const map=new Map(rows.results.map(x=>[x.ticker,x]));
  const items=await Promise.all(tickers.map(async ticker=>{
    const row=map.get(ticker),r=parse(row?.result)||{},h=(r.history?.close||[]).filter(v=>v!=null),f=r.forecast||{};
    const item={ticker,company:r.company||ticker,currency:r.currency||"USD",price:r.price??null,change_percent:r.change_percent??null,as_of:r.as_of??null,history_preview:h.length>240?h.filter((_,i)=>i%Math.ceil(h.length/240)===0):h,forecast_preview:f.hybrid||[],expected_change_percent:f.expected_change_percent??null,return_1m:r.market_summary?.return_1m??null,test_accuracy:r.model?.metrics?.backtest?.test_accuracy??r.model?.metrics?.backtest?.ensemble?.directional_accuracy??r.model?.metrics?.hybrid?.directional_accuracy??null,directional_accuracy:r.model?.metrics?.backtest?.test_accuracy??r.model?.metrics?.hybrid?.directional_accuracy??null,indexed_at:row?.indexed_at??null,has_indexed_chart:h.length>0,source:row?"RapidIndex shared cache":"not indexed"};
    if(mode==="indexed")return item;
    if(item.has_indexed_chart){try{return {...item,...await quote(ticker),source:"RapidIndex shared cache + live quote"};}catch{return item;}}
    try{return {...item,...await history(ticker),forecast_preview:[],source:"Yahoo Finance historical fallback"};}catch{return item;}
  }));
  return json({items,generated_at:now(),mode});
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(req.url);
  // Supabase's gateway path and the URL visible inside an Edge Function are
  // not guaranteed to have the same prefix. Route from the final /api/ segment
  // so both /api/market-feed and /functions/v1/<slug>/api/market-feed work.
  const rawPath = url.pathname;
  const apiMarker = rawPath.lastIndexOf("/api/");
  let path = apiMarker >= 0 ? rawPath.slice(apiMarker) : rawPath;
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path) path = "/";
  try {
    if (path.startsWith("/api/auth/")) return await authRoutes(req, env, url);
    if (path === "/api/health") {
      const identity = await env.DB.prepare("SELECT current_database() AS database_name, current_schema() AS schema_name").first();
      const rows = await env.DB.prepare("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'").all();
      const actual = new Set(rows.results.map((row) => row.table_name));
      const required = ["users","sessions","watchlist_items","analysis_jobs","market_index","market_index_catalog","api_rate_limits"];
      const missing = required.filter((name) => !actual.has(name));
      await env.DB.prepare("SELECT 1 AS ok").first();
      return json({
        ok: missing.length === 0,
        service: "stock-analyser-api",
        database: identity.database_name,
        schema: identity.schema_name,
        verified_tables: required.length - missing.length,
        missing_tables: missing,
        time: now(),
      }, missing.length ? 503 : 200);
    }
    if (path === "/api/watchlist" && req.method === "POST") return await watchlist(req, env);
    if (path === "/api/request-analysis" && req.method === "POST") return await requestAnalysis(req, env);
    if (path === "/api/analysis-status" && req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Invalid analysis ID." }, 400);
      const row = await env.DB.prepare("SELECT id,ticker,status,result,error,created_at,updated_at,progress,stage FROM analysis_jobs WHERE id=?").bind(id).first();
      if (!row) return json({ error: "Analysis request not found." }, 404);
      row.result = parse(row.result);
      return json(row);
    }
    if (path === "/api/market-feed" && req.method === "GET") return await marketFeed(req, env, url);
    if (path === "/api/stock-market-data" && req.method === "POST") return await stockMarketData(req, env);
    return json({ error: "Not found." }, 404);
  } catch (error) {
    console.error("Stock Analyser API error:", error);
    return json({ error: "The request could not be completed." }, 500);
  }
});
