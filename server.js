




import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { SocksClient } from 'socks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const credDir = resolve(__dirname, 'credentials');
if (!existsSync(credDir)) mkdirSync(credDir, { recursive: true });
const adminConfigPath = resolve(credDir, 'admin.json');

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
const worker = await import('./worker.js');
const handler = worker.default;
if (worker.setOutboundFetch) worker.setOutboundFetch(outboundFetchWithAccountProxy);


const agentCache = new Map();
function socksAgent(proxyUrl) {
  const key = proxyUrl || '__direct__';
  if (agentCache.has(key)) return agentCache.get(key);
  let agent;
  if (!proxyUrl) {
    agent = new Agent();
  } else {
    let u;
    try { u = new URL(proxyUrl); } catch { agent = new Agent(); agentCache.set(key, agent); return agent; }
    const proxy = { host: u.hostname, port: Number(u.port || 1080), type: 5 };
    if (u.username) proxy.userId = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    agent = new Agent({
      connect: (opts, cb) => {
        SocksClient.createConnection({
          proxy,
          command: 'connect',
          destination: { host: opts.hostname, port: Number(opts.port || 443), type: 'domain' },
        }).then((info) => {
          if (opts.protocol === 'https:') {
            const tls = tlsConnect({
              socket: info.socket,
              servername: opts.hostname || opts.host,
              host: opts.hostname,
              port: Number(opts.port || 443),
            });
            cb(null, tls);
          } else {
            cb(null, info.socket);
          }
        }).catch(cb);
      },
    });
  }
  agentCache.set(key, agent);
  return agent;
}


function outboundFetchWithAccountProxy(url, init, token) {
  const acct = token ? getAccounts().find((a) => a.token === token) : null;
  const proxyUrl = acct && acct.enabled ? (acct.socks5 || '') : '';
  const dispatcher = socksAgent(proxyUrl || null);
  return undiciFetch(url, { ...init, dispatcher });
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
let adminConfig = null;
let adminConfigMtime = 0;

function hashPassword(password, salt) {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

function defaultConfig() {
  const salt = randomBytes(16).toString('hex');
  const password = 'admin';
  return {
    salt,
    password_hash: hashPassword(password, salt),
    must_change_password: true,
    session_ttl_ms: 12 * 60 * 60 * 1000,
    accounts: [],
    settings: {
      api_key: process.env.FREEBUFF_API_KEY || '',
      debug: process.env.FREEBUFF_DEBUG || 'false',
      codebuff_api: process.env.CODEBUFF_API || '',
      relay_key: process.env.RELAY_KEY || '',
    },
  };
}


let initialPassword = '';
function firstBootPassword(pw) { initialPassword = pw; }

function saveAdminConfig() {
  try {
    writeFileSync(adminConfigPath, JSON.stringify(adminConfig, null, 2));
    adminConfigMtime = statSync(adminConfigPath).mtimeMs;
  } catch (e) {
    console.error('[admin] save config failed:', e.message);
  }
}


if (!existsSync(adminConfigPath)) {
  const salt = randomBytes(16).toString('hex');
  const password = 'admin';
  firstBootPassword(password);
  adminConfig = {
    salt,
    password_hash: hashPassword(password, salt),
    must_change_password: true,
    session_ttl_ms: 12 * 60 * 60 * 1000,
    accounts: [],
    settings: {
      api_key: process.env.FREEBUFF_API_KEY || '',
      debug: process.env.FREEBUFF_DEBUG || 'false',
      codebuff_api: process.env.CODEBUFF_API || '',
      relay_key: process.env.RELAY_KEY || '',
    },
  };
  saveAdminConfig();
  const pwPath = resolve(credDir, '.initial_password');
  writeFileSync(pwPath, `Initial administrator password (change it after logging in to /admin)\nPassword: ${password}\n`);
  console.log('[admin] First startup: initial password file written to', pwPath);
  console.log(`[admin] Initial password: ${password}`);
}

function reloadIfChanged() {
  try {
    const st = statSync(adminConfigPath);
    if (!adminConfig || st.mtimeMs !== adminConfigMtime) {
      adminConfig = JSON.parse(readFileSync(adminConfigPath, 'utf-8'));
      adminConfigMtime = st.mtimeMs;
    }
  } catch { /* keep current */ }
}

function getAccounts() {
  reloadIfChanged();
  return Array.isArray(adminConfig.accounts) ? adminConfig.accounts : [];
}


function migrateLegacyAccounts() {
  reloadIfChanged();
  if (adminConfig.accounts.length > 0) return;
  const found = [];
  try {
    const legacy = resolve(__dirname, 'freebuff_tools', 'freebuff_credentials.json');
    if (existsSync(legacy)) {
      const obj = JSON.parse(readFileSync(legacy, 'utf-8'));
      for (const [k, v] of Object.entries(obj.accounts || {})) {
        if (v && v.authToken) found.push({ name: v.email || k, token: v.authToken, socks5: '', enabled: true, note: 'migrated' });
      }
    }
    for (const f of existsSync(credDir) ? readdirSync(credDir) : []) {
      if (!f.endsWith('.json') || f === 'admin.json') continue;
      try {
        const obj = JSON.parse(readFileSync(resolve(credDir, f), 'utf-8'));
        if (obj.authToken) found.push({ name: f.replace('.json', ''), token: obj.authToken, socks5: '', enabled: true, note: 'migrated' });
        for (const [k, v] of Object.entries(obj.accounts || {})) {
          if (v && v.authToken) found.push({ name: v.email || k, token: v.authToken, socks5: '', enabled: true, note: 'migrated' });
        }
      } catch {}
    }
    const envToken = process.env.FREEBUFF_TOKEN || '';
    for (const tok of envToken.split(/[\n,]/)) {
      const t = tok.trim();
      if (t && !found.some((a) => a.token === t)) found.push({ name: 'env-' + found.length, token: t, socks5: '', enabled: true, note: 'migrated env' });
    }
  } catch (e) {
    console.error('[admin] legacy migrate error:', e.message);
  }
  if (found.length > 0) {
    adminConfig.accounts = found;
    saveAdminConfig();
    console.log(`[admin] Migrated ${found.length}  legacy account(s) to admin.json`);
  }
}
migrateLegacyAccounts();

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
function buildEnv() {
  reloadIfChanged();
  const s = adminConfig.settings || {};
  const tokens = getAccounts().filter((a) => a.enabled && a.token).map((a) => a.token);
  return {
    FREEBUFF_TOKEN: tokens.join(','),
    FREEBUFF_API_KEY: s.api_key || process.env.FREEBUFF_API_KEY || 'freebuff-default-key',
    FREEBUFF_DEBUG: String(s.debug ?? 'false'),
    CODEBUFF_API: s.codebuff_api || process.env.CODEBUFF_API || '',
    RELAY_KEY: s.relay_key || process.env.RELAY_KEY || '',
  };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
const sessions = new Map(); // sid -> expiresAt
const loginFails = { count: 0, lockedUntil: 0 };

function newSession(ttl) {
  const sid = randomBytes(24).toString('base64url');
  sessions.set(sid, Date.now() + ttl);
  return sid;
}
function checkSession(req) {
  const cookie = req.headers.cookie || '';
  const m = /(?:^|;\s*)fb_admin=([^;]+)/.exec(cookie);
  if (!m) return false;
  const exp = sessions.get(m[1]);
  if (!exp || Date.now() > exp) { sessions.delete(m[1]); return false; }
  return true;
}
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
const port = parseInt(process.env.PORT || '8787', 10);
const host = process.env.HOST || '0.0.0.0';



function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  if (!res.headersSent) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(body);
  } else if (!res.writableEnded) {
    res.end();
  }
  return true;
}
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf-8')); } catch { return {}; }
}
function maskToken(t) {
  if (!t || t.length < 16) return '****';
  return t.slice(0, 8) + '...' + t.slice(-4);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
async function testProxyUrl(proxyUrl) {
  const started = Date.now();
  const dispatcher = socksAgent(proxyUrl || null);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await undiciFetch('https://api.ipify.org?format=json', { dispatcher, signal: ctrl.signal });
    const j = await r.json();
    return { ok: true, ip: j.ip, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), ms: Date.now() - started };
  } finally { clearTimeout(timer); }
}

async function testAccountToken(token, proxyUrl) {
  const dispatcher = socksAgent(proxyUrl || null);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const base = (buildEnv().CODEBUFF_API) || 'https://www.codebuff.com';
    const r = await undiciFetch(base + '/api/v1/me', {
      dispatcher, signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Freebuff-Admin-Check/1.0' },
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, body: data ? { id: data.id, email: data.email, username: data.username } : text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally { clearTimeout(timer); }
}



async function queryQuota(token, proxyUrl) {
  const dispatcher = socksAgent(proxyUrl || null);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const base = (buildEnv().CODEBUFF_API) || 'https://www.codebuff.com';
    const r = await undiciFetch(base + '/api/v1/freebuff/session', {
      dispatcher, signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'include-unused-rate-limits': '1',
        'User-Agent': 'Freebuff-Admin-Check/1.0',
      },
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (!data) return { ok: false, status: r.status, raw: text.slice(0, 400) };

    if (data.error || !data.freebucks) {
      return {
        ok: false, status: r.status, access_tier: data.accessTier,
        banned: /suspend|banned/i.test(String(data.error || '') + String(data.status || '')),
        error: data.message || data.error || data.status || 'No quota data',
      };
    }
    const fb = data.freebucks;
    return {
      ok: r.ok, status: r.status,
      access_tier: data.accessTier,
      status_field: data.status,
      balance: fb.balance,
      daily: fb.daily || null,
      wallet_balance: fb.wallet?.balance,
      plan_id: fb.planId,
      prices: fb.prices || {},
      price_notices: fb.priceNotices || {},
      off_peak: fb.offPeak || {},
      price_changes: fb.priceChanges || [],
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>freebuff2api Admin Panel</title>
<style>
:root{--bg:#0f1420;--card:#171e2e;--line:#26304a;--tx:#dbe4ff;--dim:#8b96b8;--ok:#3ddc97;--err:#ff6b6b;--pri:#5b8cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--dim);font-size:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.card h2{font-size:15px;margin:0 0 12px}
input,select{background:#0c111c;border:1px solid var(--line);color:var(--tx);border-radius:8px;padding:8px 10px;font-size:13px;width:100%}
input:focus{outline:1px solid var(--pri)}
button{background:var(--pri);border:0;color:#fff;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--tx)}
button.mini{padding:4px 10px;font-size:12px}
button.danger{background:transparent;border:1px solid var(--err);color:var(--err)}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:1fr 2fr 2fr auto;gap:8px;align-items:center}
.acct{border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:10px}
.acct .grid{grid-template-columns:110px 1fr 1fr auto}
label{font-size:12px;color:var(--dim)}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;border:1px solid var(--line)}
.badge.ok{color:var(--ok);border-color:var(--ok)}.badge.err{color:var(--err);border-color:var(--err)}
.msg{font-size:12px;margin-top:6px;min-height:16px;white-space:pre-wrap;word-break:break-all}
.ok{color:var(--ok)}.err{color:var(--err)}.dim{color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left;word-break:break-all}
.login{max-width:380px;margin:12vh auto}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
hr{border:0;border-top:1px solid var(--line);margin:14px 0}
</style></head><body>
<div class="wrap" id="app"></div>
<script>
const $=(q)=>document.querySelector(q);
let state={login:false,must:false,accounts:[],settings:{},tests:{}};
async function api(path,opt={}){
  const r=await fetch('/admin/api'+path,{headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},credentials:'same-origin',...opt});
  const j=await r.json().catch(()=>({}));
  if(r.status===401&&path!=='/login'){state.login=false;render();throw new Error('Not logged in');}
  if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
  return j;
}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
async function render(){
  const app=$('#app');
  if(!state.login){
    app.innerHTML='<div class="login card"><h2>freebuff2api Admin Login</h2>'
      +(state.must?'<div class="msg err">First use: sign in with the initial password admin, then change it.</div>':'')
      +'<label>Administrator Password</label><input id="pw" type="password" style="margin:6px 0 12px">'
      +'<button id="btnLogin" style="width:100%">Sign In</button><div class="msg" id="loginMsg"></div></div>';
    $('#btnLogin').onclick=doLogin;$('#pw').onkeydown=e=>{if(e.key==='Enter')doLogin()};
    return;
  }
  const accts=state.accounts.map((a,i)=>\`
    <div class="acct" data-i="\${i}">
      <div class="grid">
        <div><label>Name</label><input class="f-name" value="\${esc(a.name)}"></div>
        <div><label>Token (leave blank to keep the current value)</label><input class="f-token mono" placeholder="\${esc(a.token_masked)}"></div>
        <div><label>SOCKS5 outbound (socks5://user:pass@host:port; blank = direct)</label><input class="f-socks mono" value="\${esc(a.socks5)}" placeholder="socks5://127.0.0.1:1080"></div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" class="f-enabled" \${a.enabled?'checked':''} style="width:auto">Enabled</label>
          <div class="row" style="gap:4px">
            <button class="mini ghost act-test-proxy">Test Proxy</button>
            <button class="mini ghost act-test-acct">Test Account</button>
            <button class="mini ghost act-quota">Check Quota</button>
            <button class="mini danger act-del">Delete</button>
          </div>
        </div>
      </div>
      <div class="msg" id="msg-\${i}"></div>
    </div>\`).join('');
  app.innerHTML=\`
  <h1>freebuff2api Admin Panel</h1><div class="sub">Docker host · Per-account SOCKS5 outbound routing · Saved changes apply immediately (no container restart required)</div>
  <div class="card"><h2>Account Pool (one independent SOCKS5 outbound route per account)</h2>\${accts||'<div class="dim">No accounts yet</div>'}
    <div class="row" style="margin-top:8px"><button id="btnAdd">＋ Add Account</button><button id="btnSaveAccts" class="ghost">Save Accounts</button><button id="btnQuotas" class="ghost">💰 Check All Quotas</button></div>
    <div class="msg" id="acctMsg"></div>
    <div id="quotaBox" class="dim" style="margin-top:8px"></div>
  </div>
  <div class="card"><h2>Service Variables</h2>
    <div class="grid" style="grid-template-columns:140px 1fr 140px 1fr">
      <div><label>API Key (client authentication)</label><input id="s-apikey" value="\${esc(state.settings.api_key||'')}"></div>
      <div><label>CODEBUFF_API (blank = official upstream)</label><input id="s-api" class="mono" value="\${esc(state.settings.codebuff_api||'')}"></div>
      <div><label>RELAY_KEY</label><input id="s-relay" class="mono" value="\${esc(state.settings.relay_key||'')}"></div>
      <div><label>DEBUG</label><select id="s-debug"><option value="false" \${state.settings.debug!=='true'?'selected':''}>false</option><option value="true" \${state.settings.debug==='true'?'selected':''}>true</option></select></div>
    </div>
    <div class="row" style="margin-top:10px"><button id="btnSaveSettings" class="ghost">Save Variables</button></div>
    <div class="msg" id="setMsg"></div>
  </div>
  <div class="card"><h2>Service Status</h2><div id="healthBox" class="dim">Loading…</div></div>
  <div class="card"><h2>Change Administrator Password</h2>
    <div class="row">
      <input id="pw-old" type="password" placeholder="Current password" style="max-width:200px">
      <input id="pw-new" type="password" placeholder="New password (≥8 characters)" style="max-width:200px">
      <button id="btnPw" class="ghost">Change Password</button>
    </div><div class="msg" id="pwMsg"></div>
  </div>
  <div class="sub">Sign out <a href="#" id="btnLogout" style="color:var(--pri)">logout</a> · Data is stored in credentials/admin.json · Forgot the password? Delete this file and restart the container</div>\`;
  bind();
  loadHealth();
}
async function doLogin(){
  const pw=$('#pw').value;
  try{const j=await api('/login',{method:'POST',body:JSON.stringify({password:pw})});
    state.login=true;state.must=!!j.must_change_password;
    if(state.must){await render();$('#app').innerHTML='<div class="login card"><h2>The initial password must be changed</h2><label>New password (≥8 characters)</label><input id="np" type="password" style="margin:6px 0 12px"><button id="btnNP" style="width:100%">Save New Password</button><div class="msg" id="npMsg"></div></div>';$('#btnNP').onclick=async()=>{try{await api('/change_password',{method:'POST',body:JSON.stringify({new_password:$('#np').value})});state.must=false;await refresh();}catch(e){$('#npMsg').innerHTML='<span class="err">'+esc(e.message)+'</span>';}};return;}
    await refresh();
  }catch(e){$('#loginMsg').innerHTML='<span class="err">'+esc(e.message)+'</span>';}
}
async function refresh(){
  const c=await api('/config');
  state.accounts=c.accounts;state.settings=c.settings;state.must=!!c.must_change_password;
  await render();
}
function collectAccts(){
  return [...document.querySelectorAll('.acct')].map((el)=>{
    const i=+el.dataset.i;const old=state.accounts[i]||{};
    const tok=el.querySelector('.f-token').value.trim();
    return {name:el.querySelector('.f-name').value.trim()||('acct-'+i),
      token:tok||undefined, socks5:el.querySelector('.f-socks').value.trim(),
      enabled:el.querySelector('.f-enabled').checked};
  });
}
function bind(){
  $('#btnAdd').onclick=()=>{state.accounts.push({name:'new-acct',token:'',token_masked:'new token',socks5:'',enabled:true});render()};
  $('#btnQuotas').onclick=async()=>{
    const box=$('#quotaBox');box.innerHTML='Checking… (querying upstream per account)';
    try{const j=await api('/quotas');
      box.innerHTML='<table><tr><th>Account</th><th>Quota</th></tr>'
        +j.accounts.map(a=>'<tr><td>'+esc(a.name)+'<div class="dim mono">'+esc(a.token_masked||'')+'</div></td><td>'+renderQuota(a)+'</td></tr>').join('')
        +'</table>';
    }catch(e){box.innerHTML='<span class="err">'+esc(e.message)+'</span>'}};
$('#btnSaveAccts').onclick=async()=>{try{const j=await api('/accounts',{method:'POST',body:JSON.stringify({accounts:collectAccts()})});state.accounts=j.accounts;$('#acctMsg').innerHTML='<span class="ok">Saved; changes are effective immediately</span>';render()}catch(e){$('#acctMsg').innerHTML='<span class="err">'+esc(e.message)+'</span>'}};
  $('#btnSaveSettings').onclick=async()=>{try{await api('/settings',{method:'POST',body:JSON.stringify({settings:{api_key:$('#s-apikey').value.trim(),codebuff_api:$('#s-api').value.trim(),relay_key:$('#s-relay').value.trim(),debug:$('#s-debug').value}})});$('#setMsg').innerHTML='<span class="ok">Saved; changes are effective immediately</span>'}catch(e){$('#setMsg').innerHTML='<span class="err">'+esc(e.message)+'</span>'}};
  $('#btnPw').onclick=async()=>{try{await api('/change_password',{method:'POST',body:JSON.stringify({old_password:$('#pw-old').value,new_password:$('#pw-new').value})});$('#pwMsg').innerHTML='<span class="ok">Changed</span>'}catch(e){$('#pwMsg').innerHTML='<span class="err">'+esc(e.message)+'</span>'}};
  $('#btnLogout').onclick=async(e)=>{e.preventDefault();await api('/logout',{method:'POST'});state.login=false;render()};
  document.querySelectorAll('.acct').forEach((el)=>{
    const i=+el.dataset.i;
    el.querySelector('.act-del').onclick=()=>{state.accounts.splice(i,1);render()};
    el.querySelector('.act-test-proxy').onclick=async()=>{
      const m=el.querySelector('.msg');m.textContent='Testing…';
      try{const j=await api('/test_proxy',{method:'POST',body:JSON.stringify({socks5:el.querySelector('.f-socks').value.trim()})});
        m.innerHTML=j.ok?('<span class="ok">✅ Outbound IP '+esc(j.ip)+'（'+j.ms+'ms）</span>'):('<span class="err">❌ '+esc(j.error||'Failed')+'</span>')}catch(e){m.innerHTML='<span class="err">'+esc(e.message)+'</span>'}};
    el.querySelector('.act-quota').onclick=async()=>{
      const m=el.querySelector('.msg');m.textContent='Checking quota…';
      const tok=el.querySelector('.f-token').value.trim()||null;
      try{const j=await api('/quota',{method:'POST',body:JSON.stringify({index:i,token:tok,socks5:el.querySelector('.f-socks').value.trim()})});
        m.innerHTML=renderQuota(j)}catch(e){m.innerHTML='<span class="err">'+esc(e.message)+'</span>'}
    };
    el.querySelector('.act-test-acct').onclick=async()=>{
      const m=el.querySelector('.msg');m.textContent='Testing…';
      const tok=el.querySelector('.f-token').value.trim()||null;
      try{const j=await api('/test_account',{method:'POST',body:JSON.stringify({index:i,token:tok,socks5:el.querySelector('.f-socks').value.trim()})});
        m.innerHTML=j.ok?('<span class="ok">✅ HTTP '+j.status+' '+esc(JSON.stringify(j.body))+'</span>'):('<span class="err">❌ HTTP '+(j.status||'')+' '+esc(j.error||JSON.stringify(j.body||''))+'</span>')}catch(e){m.innerHTML='<span class="err">'+esc(e.message)+'</span>'}};
  });
}
function fmtReset(iso){
  if(!iso)return '';
  const d=new Date(iso);if(isNaN(d))return esc(String(iso));
  const p=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes());
}
function renderQuota(j){
  if(!j)return '<span class="err">Empty response</span>';
  if(!j.ok&&!j.daily){
    return '<span class="err">❌ '+(j.banned?'Account banned: ':'')+esc(j.error||('HTTP '+(j.status||'')))+'</span>';
  }
  const d=j.daily||{};
  const rem=Number(d.remaining||0), lim=Number(d.limit||0), spent=Number(d.spent||0);
  const cls=rem>0?'ok':'err';
  let s='<span class="'+cls+'">💰 Freebucks '+rem+'/'+lim
    +(spent?'（Used '+spent+'）':'')+' · Reset '+fmtReset(d.resetAt)+'</span>';
  s+=' · tier=<b>'+esc(j.access_tier||'?')+'</b>';
  if(j.plan_id)s+=' · plan='+esc(j.plan_id);
  const pr=j.prices||{};
  const names=Object.keys(pr);
  if(names.length){
    const sorted=names.slice().sort((a,b)=>pr[a]-pr[b]);
    s+='<div class="dim" style="margin-top:4px">Affordable requests: '
      +sorted.map(function(m){
        const cost=pr[m];
        const times=cost>0?Math.floor(rem/cost):rem;
        return '<span class="'+(times>0?'ok':'err')+'" title="'+esc(m)+'（'+cost+'）">'+esc(m.split('/').pop())+'×'+times+'</span>';
      }).join(' · ')+'</div>';
    const notices=j.price_notices||{};
    const np=Object.keys(notices).map(function(m){return esc(m.split('/').pop())+': '+esc(notices[m])});
    if(np.length)s+='<div class="dim" style="margin-top:2px">⚠ '+np.join(' · ')+'</div>';
  }
  return s;
}
async function loadHealth(){
  try{const j=await api('/status');
    $('#healthBox').innerHTML='<table><tr><th>Name</th><th>Outbound</th><th>token</th><th>Enabled</th></tr>'
      +j.accounts.map(a=>'<tr><td>'+esc(a.name)+'</td><td class="mono">'+(a.socks5?esc(a.socks5):'<span class="dim">Direct</span>')+'</td><td class="mono">'+esc(a.token_masked)+'</td><td>'+(a.enabled?'<span class="ok">on</span>':'<span class="err">off</span>')+'</td></tr>').join('')
      +'</table><div class="dim" style="margin-top:6px">Models: '+j.models_count+' · worker: '+esc(j.version)+' · token pool: '+j.token_pool_size+' enabled account(s)</div>';
  }catch(e){$('#healthBox').textContent='Failed to load: '+e.message}
}
render();
</script></body></html>`;

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
async function handleAdmin(req, res, url) {
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(ADMIN_HTML);
    return true;
  }
  if (!path.startsWith('/admin/api/')) return false;
  const apiPath = path.slice('/admin/api'.length);

  try {
    if (apiPath === '/login' && req.method === 'POST') {
      const now = Date.now();
      if (now < loginFails.lockedUntil) return sendJson(res, 429, { error: 'Too many attempts; try again later' });
      const { password } = await readJson(req);
      reloadIfChanged();
      const okCfg = adminConfig;
      const ok = safeEqual(hashPassword(String(password || ''), okCfg.salt), okCfg.password_hash);
      if (!ok) {
        loginFails.count++;
        if (loginFails.count >= 5) { loginFails.lockedUntil = now + 5 * 60 * 1000; loginFails.count = 0; }
        return sendJson(res, 401, { error: 'Incorrect password' });
      }
      loginFails.count = 0;
      const sid = newSession(okCfg.session_ttl_ms || 12 * 3600e3);
      return sendJson(res, 200, { ok: true, must_change_password: !!okCfg.must_change_password },
        { 'Set-Cookie': `fb_admin=${sid}; Path=/; HttpOnly; SameSite=Strict` });
    }


    if (!checkSession(req)) return sendJson(res, 401, { error: 'Not logged in' });

    if (apiPath === '/logout' && req.method === 'POST') {
      const m = /(?:^|;\s*)fb_admin=([^;]+)/.exec(req.headers.cookie || '');
      if (m) sessions.delete(m[1]);
      return sendJson(res, 200, { ok: true });
    }

    reloadIfChanged();

    if (apiPath === '/change_password' && req.method === 'POST') {
      const { old_password, new_password } = await readJson(req);
      if (!adminConfig.must_change_password) {
        if (!safeEqual(hashPassword(String(old_password || ''), adminConfig.salt), adminConfig.password_hash))
          return sendJson(res, 400, { error: 'Current password is incorrect' });
      }
      if (!new_password || String(new_password).length < 8) return sendJson(res, 400, { error: 'New password must be at least 8 characters' });
      adminConfig.salt = randomBytes(16).toString('hex');
      adminConfig.password_hash = hashPassword(String(new_password), adminConfig.salt);
      adminConfig.must_change_password = false;
      saveAdminConfig();
      return sendJson(res, 200, { ok: true });
    }

    if (adminConfig.must_change_password)
      return sendJson(res, 403, { error: 'You must change the initial password first', must_change: true });

    if (apiPath === '/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        must_change_password: !!adminConfig.must_change_password,
        accounts: getAccounts().map((a) => ({ name: a.name, socks5: a.socks5, enabled: !!a.enabled, note: a.note || '', token_masked: maskToken(a.token) })),
        settings: adminConfig.settings || {},
      });
    }

    if (apiPath === '/accounts' && req.method === 'POST') {
      const { accounts } = await readJson(req);
      if (!Array.isArray(accounts)) return sendJson(res, 400, { error: 'accounts must be an array' });
      const existing = getAccounts();
      adminConfig.accounts = accounts.map((a, i) => {
        const prev = existing.find((p) => p.name === a.name);
        return {
          name: String(a.name || `acct-${i}`).slice(0, 64),
          token: (a.token && String(a.token).trim()) || (prev ? prev.token : ''),
          socks5: String(a.socks5 || '').trim(),
          enabled: a.enabled !== false,
          note: a.note || prev?.note || '',
        };
      }).filter((a) => a.token);
      saveAdminConfig();
      return sendJson(res, 200, { ok: true, accounts: adminConfig.accounts.map((a) => ({ name: a.name, socks5: a.socks5, enabled: a.enabled, token_masked: maskToken(a.token) })) });
    }

    if (apiPath === '/settings' && req.method === 'POST') {
      const { settings } = await readJson(req);
      if (!settings || typeof settings !== 'object') return sendJson(res, 400, { error: 'settings must be an object' });
      adminConfig.settings = {
        api_key: String(settings.api_key ?? adminConfig.settings?.api_key ?? ''),
        debug: settings.debug === 'true' ? 'true' : 'false',
        codebuff_api: String(settings.codebuff_api ?? adminConfig.settings?.codebuff_api ?? ''),
        relay_key: String(settings.relay_key ?? adminConfig.settings?.relay_key ?? ''),
      };
      saveAdminConfig();
      return sendJson(res, 200, { ok: true });
    }

    if (apiPath === '/test_proxy' && req.method === 'POST') {
      const { socks5 } = await readJson(req);
      const v = socks5 && !/^socks5:\/\//.test(socks5) ? null : (socks5 || '');
      if (socks5 && v === null) return sendJson(res, 400, { error: 'socks5 format: socks5://user:pass@host:port' });
      const r = await testProxyUrl(v);
      return sendJson(res, 200, r);
    }

    if (apiPath === '/test_account' && req.method === 'POST') {
      const { index, token, socks5 } = await readJson(req);
      const acc = getAccounts()[Number(index)];
      const tok = (token && String(token).trim()) || acc?.token;
      if (!tok) return sendJson(res, 400, { error: 'No token (save one first or provide a token)' });
      const r = await testAccountToken(tok, socks5 !== undefined ? socks5 : acc?.socks5);
      return sendJson(res, 200, r);
    }

    if (apiPath === '/quota' && req.method === 'POST') {
      const { index, token, socks5 } = await readJson(req);
      const acc = getAccounts()[Number(index)];
      const tok = (token && String(token).trim()) || acc?.token;
      if (!tok) return sendJson(res, 400, { error: 'No token (save one first or provide a token)' });
      const r = await queryQuota(tok, socks5 !== undefined ? socks5 : acc?.socks5);
      return sendJson(res, 200, r);
    }

    if (apiPath === '/quotas' && req.method === 'GET') {
      const list = getAccounts();
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a.token) { out.push({ name: a.name, ok: false, error: 'No token' }); continue; }
        out.push({ name: a.name, token_masked: maskToken(a.token), ...(await queryQuota(a.token, a.socks5)) });
      }
      return sendJson(res, 200, { accounts: out });
    }

    if (apiPath === '/status' && req.method === 'GET') {
      const env = buildEnv();
      let models_count = 0;
      try {
        const mr = await handler.fetch(new Request(`http://local/v1/models`), env);
        const mj = await mr.json();
        models_count = Array.isArray(mj?.data) ? mj.data.length : 0;
      } catch {}
      return sendJson(res, 200, {
        version: worker.VERSION || 'unknown',
        token_pool_size: env.FREEBUFF_TOKEN.split(',').filter((t) => t.length > 8).length,
        accounts: getAccounts().map((a) => ({ name: a.name, socks5: a.socks5, enabled: a.enabled, token_masked: maskToken(a.token) })),
        models_count,
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    return sendJson(res, 500, { error: String(e && e.message || e) });
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
const server = createServer(async (nodeReq, nodeRes) => {
  const url = new URL(nodeReq.url || '/', `http://${nodeReq.headers.host || 'localhost'}`);
  try {

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const handled = await handleAdmin(nodeReq, nodeRes, url);
      if (handled) return;
    }

    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const reqUrl = `http://${nodeReq.headers.host || 'localhost'}${nodeReq.url}`;
    const request = new Request(reqUrl, {
      method: nodeReq.method,
      headers: new Headers(nodeReq.headers),
      body: body.length > 0 ? body : null,
    });

    const response = await handler.fetch(request, buildEnv());

    nodeRes.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) nodeRes.write(Buffer.from(value));
        }
      } catch {
        if (!nodeRes.writableEnded) nodeRes.end();
        return;
      }
    }
    if (!nodeRes.writableEnded) nodeRes.end();
  } catch (err) {
    console.error('[server] request error:', err.message);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(502, { 'content-type': 'application/json' });
      nodeRes.end(JSON.stringify({ error: { message: 'proxy error', type: 'proxy_error' } }));
    } else if (!nodeRes.writableEnded) {
      nodeRes.end();
    }
  }
});

server.listen(port, host, () => {
  const env = buildEnv();
  console.log(`[server] listening on ${host}:${port}`);
  console.log(`[server] admin panel: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/admin`);
  console.log(`[server] ${env.FREEBUFF_TOKEN.split(',').filter((t) => t.length > 8).length} tokens loaded, apiKey=${env.FREEBUFF_API_KEY.slice(0, 8)}...`);
});
