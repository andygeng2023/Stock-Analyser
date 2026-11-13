(() => {
  const KEY = "stock-analyser-session-v1";
  const listeners = new Set();
  let session = null;
  const base = () => (window.STOCK_ANALYSER_CONFIG?.apiBaseUrl || "").replace(/\/$/,"");
  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY)||"null"); } catch { return null; } };
  const store = value => { session=value||null; try { value?localStorage.setItem(KEY,JSON.stringify(value)):localStorage.removeItem(KEY); } catch {} };
  const emit = event => listeners.forEach(fn => { try { fn(event,session); } catch(e) { console.warn(e); } });
  async function call(path,{method="GET",body}={}) {
    const token=session?.access_token;
    const response=await fetch(base()+"/api/auth/"+path,{method,headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},body:body?JSON.stringify(body):undefined});
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||"Authentication request failed.");
    return data;
  }
  async function restore() {
    if(session?.access_token)return session;
    const old=saved(); if(!old?.access_token)return null;
    session=old;
    try { const data=await call("me"); session={...old,user:data.user};store(session);return session; }
    catch {store(null);return null;}
  }
  const auth={
    async getSession(){try{return {data:{session:await restore()},error:null};}catch(error){return {data:{session:null},error};}},
    async getUser(){try{const s=await restore();if(!s)return {data:{user:null},error:new Error("Sign in again.")};const d=await call("me");session={...s,user:d.user};store(session);return {data:{user:d.user},error:null};}catch(error){return {data:{user:null},error};}},
    onAuthStateChange(fn){listeners.add(fn);restore().then(s=>fn("INITIAL_SESSION",s));return {data:{subscription:{unsubscribe:()=>listeners.delete(fn)}}};},
    async signUp({email,password}){try{const d=await call("signup",{method:"POST",body:{email,password}});store(d.session);emit("SIGNED_IN");return {data:d,error:null};}catch(error){return {data:{user:null,session:null},error};}},
    async signInWithPassword({email,password}){try{const d=await call("login",{method:"POST",body:{email,password}});store(d.session);emit("SIGNED_IN");return {data:d,error:null};}catch(error){return {data:{user:null,session:null},error};}},
    async signOut({scope}={}){try{if(session?.access_token)await call(scope==="global"?"logout-all":scope==="others"?"logout-others":"logout",{method:"POST"});store(null);emit("SIGNED_OUT");return {error:null};}catch(error){return {error};}},
    async updateUser(values){try{let d;if(values.password){d=await call("password",{method:"PATCH",body:{password:values.password}});}else if(values.email){throw new Error("Email changes are unavailable because no email verification service is configured.");}else{d=await call("profile",{method:"PATCH",body:{display_name:values.data?.display_name||""}});}if(d.user){session={...session,user:d.user};store(session);emit("USER_UPDATED");}return {data:{user:d.user||session?.user},error:null};}catch(error){return {data:{user:session?.user},error};}},
    async resetPasswordForEmail(email){try{await call("reset",{method:"POST",body:{email}});return {error:null};}catch(error){return {error};}}
  };
  window.stockAnalyserAuth={createClient:()=>({auth})};
})();