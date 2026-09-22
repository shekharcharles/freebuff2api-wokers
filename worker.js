const CODEBUFF_API = "https://www.codebuff.com";
const DEFAULT_MODEL = "mimo/mimo-v2.5";
const DEFAULT_API_KEY = "freebuff-default-key";
const VERSION = "1.8.11.1";
const CONTEXT_PRUNER_AGENT = "context-pruner";
const SDK_UA = "ai-sdk/openai-compatible/1.0.25/codebuff";














const DYNAMIC_MODELS_SOURCES = [
  "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/free-agents.ts",
  "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/free-agents.ts",
];
const DYNAMIC_MODELS_MODEL_IDS_SOURCES = [
  "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-models.ts",
  "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-models.ts",
];
const DYNAMIC_MODELS_STABLE_IDS_SOURCES = [
  "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-model-ids.ts",
  "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-model-ids.ts",
];



const DYNAMIC_MODELS_RELEASE_SOURCES = [
  "https://github.com/pingmike2/freebuff2api-wokers/releases/latest/download/freebuff-models.json",
];

const DYNAMIC_MODELS_REFRESH_MS = 6 * 60 * 60 * 1000;
const DYNAMIC_MODELS_FETCH_TIMEOUT_MS = 10000;


let dynamicModelsCache = {
  fetchedAt: 0,
  models: null,
  pool: null, // { premium: Set, standard: Set, glm: Set }
};



//   export const FREEBUFF_MIMO_V25_MODEL_ID = mimoModels.mimoV25
//   export const FREEBUFF_MINIMAX_M3_MODEL_ID = 'minimax/minimax-m3'

function parseModelIdConstants(source) {
  const table = {};
  const knownDefaults = {
    mimoV25: "mimo/mimo-v2.5",
  };

  const re = /export\s+const\s+([A-Z0-9_]+)\s*=\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z0-9_.]+))/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    const lit = m[2] ?? m[3] ?? "";
    const expr = m[4] ?? "";
    if (lit) table[name] = lit;
    else if (expr) {

      const member = expr.includes(".") ? expr.split(".").pop() : expr;
      if (knownDefaults[member]) table[name] = knownDefaults[member];
      else if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.:/-]+$/.test(expr)) table[name] = expr;
    }
  }
  return table;
}



function parseAgentMappings(source, modelIdConstants) {
  const blockNames = {
    root: "FREEBUFF_ROOT_AGENT_ID_BY_MODEL",
    base3: "FREEBUFF_WEB_BASE3_AGENT_ID_BY_MODEL",
    reviewer: "FREEBUFF_REVIEWER_AGENT_ID_BY_MODEL",
  };
  const result = { root: {}, base3: {}, reviewer: {} };
  const lineRe = /\[\s*([A-Z0-9_]+)\s*\]\s*:\s*'([^']+)'/g;
  for (const [kind, blockName] of Object.entries(blockNames)) {
    const blockRe = new RegExp(`${blockName}[^=]*=\\s*\\{([^}]*)\\}`);
    const blockMatch = blockRe.exec(source);
    if (!blockMatch) continue;
    let m;
    lineRe.lastIndex = 0;
    while ((m = lineRe.exec(blockMatch[1])) !== null) {
      const modelId = modelIdConstants[m[1]];
      if (modelId) result[kind][modelId] = m[2];
    }
  }
  return result;
}


function parseAgentMapping(source, modelIdConstants) {
  return parseAgentMappings(source, modelIdConstants).root;
}



function parseModelPools(source, modelIdConstants) {
  const premium = new Set();
  const glm = new Set();
  const used = new Set();

  const constValues = new Map();
  const constListRe = /export\s+const\s+([A-Z0-9_]+)\s*=\s*\[([^\]]*)\]\s*as\s*const/g;
  let cm;
  while ((cm = constListRe.exec(source)) !== null) {
    const name = cm[1];
    const items = [];
    const itemRe = /\.\.\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+)/g;
    let im;
    while ((im = itemRe.exec(cm[2])) !== null) {
      const spread = im[1];
      const lit = im[2] ?? im[3];
      const expr = im[4];
      if (spread) items.push(["spread", spread]);
      else if (lit) items.push(["lit", lit]);
      else if (expr && modelIdConstants[expr]) items.push(["lit", modelIdConstants[expr]]);
    }
    constValues.set(name, items);
  }





  const poolRe = /export\s+const\s+(FREEBUFF_WEB_PREMIUM_MODEL_IDS|FREEBUFF_GLM_V52_MODEL_IDS|FREEBUFF_PREMIUM_MODEL_IDS)\s*=\s*(Object\.freeze\()?\s*\[([^\]]*)\]/g;
  let pm;
  while ((pm = poolRe.exec(source)) !== null) {
    const poolName = pm[1];
    const items = [];
    const itemRe = /\.\.\.([A-Z0-9_]+)|'([^']*)'|"([^"]*)"|([A-Za-z0-9_]+)/g;
    let im;
    while ((im = itemRe.exec(pm[2])) !== null) {
      const spread = im[1];
      const lit = im[2] ?? im[3];
      const expr = im[4];
      if (spread) {

        const expand = (n) => {
          const entries = constValues.get(n) || [];
          for (const [kind, val] of entries) {
            if (kind === "spread") expand(val);
            else items.push(val);
          }
        };
        expand(spread);
      } else if (lit) items.push(lit);
      else if (expr && modelIdConstants[expr]) items.push(modelIdConstants[expr]);
    }
    if (poolName === "FREEBUFF_GLM_V52_MODEL_IDS") {
      for (const id of items) glm.add(id);
    } else {
      for (const id of items) premium.add(id);
    }
  }

  return { premium: [...premium], glm: [...glm] };
}





function parseCatalogPremiumFlags(source, modelIdConstants) {
  const premium = new Set();
  const blockRe = /const\s+([A-Z0-9_]+)\s*=\s*\{([^{}]*)\}\s*as\s*const/g;
  let bm;
  while ((bm = blockRe.exec(source)) !== null) {
    const body = bm[2];
    if (!/^\s*premium:/m.test(body)) continue;
    const idM = /\n\s*id:\s*('([^']+)'|"([^"]+)"|([A-Z0-9_]+)),/.exec(body);
    if (!idM) continue;
    const modelId = idM[2] || idM[3] || modelIdConstants[idM[4]];
    if (!modelId) continue;
    const pM = /\n\s*premium:\s*([^,\n]+),/.exec(body);
    if (!pM) continue;
    if (pM[1].trim() === "true") premium.add(modelId);
  }
  return { premium: [...premium] };
}


function buildDynamicModelTable(agentMappings) {

  const mappings = agentMappings && agentMappings.root
    ? agentMappings
    : { root: agentMappings || {}, base3: {}, reviewer: {} };
  return Object.entries(mappings.root).map(([modelId, rootAgent]) => ({
    id: modelId,
    session: modelId,

    agent: rootAgent,
    root_agent: rootAgent,
    base3_agent: mappings.base3[modelId] || null,
    reviewer_agent: mappings.reviewer[modelId] || null,
    upstream: modelId,
  }));
}


function mergeModelTables(hardcoded, dynamic) {
  const seen = new Set(hardcoded.map((m) => m.id));
  const merged = [...hardcoded];
  for (const m of dynamic) {
    if (!seen.has(m.id)) {
      merged.push(m);
      seen.add(m.id);
    }
  }
  return merged;
}


async function fetchSourceList(urls) {
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DYNAMIC_MODELS_FETCH_TIMEOUT_MS);



      const resp = await fetch(url, { signal: ctrl.signal, headers: { "accept-encoding": "identity" } });
      clearTimeout(timer);
      if (resp.ok) {
        const text = await resp.text();


        if (text && text.length > 100) return text;
      }
    } catch {}
  }
  return null;
}

async function refreshDynamicModelsIfStale() {
  const now = Date.now();
  if (dynamicModelsCache.models && now - dynamicModelsCache.fetchedAt < DYNAMIC_MODELS_REFRESH_MS) {
    return dynamicModelsCache;
  }

  const [agentsSrc, modelsSrc, stableIdsSrc] = await Promise.all([
    fetchSourceList(DYNAMIC_MODELS_SOURCES),
    fetchSourceList(DYNAMIC_MODELS_MODEL_IDS_SOURCES),
    fetchSourceList(DYNAMIC_MODELS_STABLE_IDS_SOURCES),
  ]);
  if (!agentsSrc || !modelsSrc) {

    const release = await tryReleaseFallback();
    if (release) {
      dynamicModelsCache = release;
      return dynamicModelsCache;
    }

    return dynamicModelsCache;
  }
  try {

    const modelIdConstants = { ...parseModelIdConstants(stableIdsSrc || ""), ...parseModelIdConstants(modelsSrc) };
    const agentMappings = parseAgentMappings(agentsSrc, modelIdConstants);
    if (Object.keys(agentMappings.root).length === 0) {

      const release = await tryReleaseFallback();
      if (release) {
        dynamicModelsCache = release;
        return dynamicModelsCache;
      }
      return dynamicModelsCache;
    }
    const pools = parseModelPools(modelsSrc, modelIdConstants);

    const premiumIds = pools.premium.length > 0
      ? pools.premium
      : parseCatalogPremiumFlags(modelsSrc, modelIdConstants).premium;
    dynamicModelsCache = {
      fetchedAt: Date.now(),
      models: buildDynamicModelTable(agentMappings),
      pool: {
        premium: new Set(premiumIds),
        standard: null,
        glm: new Set(pools.glm),
      },
    };
  } catch {

    const release = await tryReleaseFallback();
    if (release) {
      dynamicModelsCache = release;
      return dynamicModelsCache;
    }

  }
  return dynamicModelsCache;
}


async function tryReleaseFallback() {
  for (const url of DYNAMIC_MODELS_RELEASE_SOURCES) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DYNAMIC_MODELS_FETCH_TIMEOUT_MS);

      const resp = await fetch(url, { signal: ctrl.signal, headers: { "accept-encoding": "identity" } });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        if (json && Array.isArray(json.models) && json.models.length > 0) {
          return {
            fetchedAt: Date.now(),
            models: json.models,
            pool: {
              premium: new Set(json.pools?.premium ?? []),
              standard: null,
              glm: new Set(json.pools?.glm ?? []),
            },
          };
        }
      }
    } catch {}
  }
  return null;
}


function dynamicStandardModels() {
  const cache = dynamicModelsCache;
  if (!cache || !cache.models || !cache.pool) return new Set();
  const premium = cache.pool.premium;
  const glm = cache.pool.glm;
  return new Set(cache.models.map((m) => m.id).filter((id) => !premium.has(id) && !glm.has(id)));
}



function modelPoolCategory(modelId) {
  if (isPausedModel(modelId)) return null;
  const dyn = dynamicModelsCache;
  if (dyn && dyn.pool) {
    if (dyn.pool.premium.has(modelId)) return "premium";
    if (dyn.pool.glm.has(modelId)) return "glm";
    if (dynamicStandardModels().has(modelId)) return "standard";
  }

  if (PREMIUM_QUOTA_MODELS.has(modelId)) return "premium";
  if (STANDARD_MODELS.has(modelId)) return "standard";
  return null;
}






const MODELS = [
  { id: "mimo/mimo-v2.5", session: "mimo/mimo-v2.5", agent: "base2-free-mimo", upstream: "mimo/mimo-v2.5" },
];

// ---------------------------------------------------------------------------

//







//




//   （occupiesFreebuffDesktopSlot / getFreebuffDesktopSessionBucket）
//



// ---------------------------------------------------------------------------
const PREMIUM_QUOTA_MODELS = new Set([
  "deepseek/deepseek-v4-pro",
  "openai/gpt-5.6-luna",
  "minimax/minimax-m3",
  "meta/muse-spark-1.2-contributor",
]);
const STANDARD_MODELS = new Set([
  "deepseek/deepseek-v4-flash",
  "mimo/mimo-v2.5",
]);

// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
const PAUSED_MODELS = new Set([
  "deepseek/deepseek-v4-flash",


  "minimax/minimax-m3",
]);

function isPausedModel(modelId) {
  return PAUSED_MODELS.has(modelId);
}

// ---------------------------------------------------------------------------






// ---------------------------------------------------------------------------
const DESKTOP_INCLUDE_RATE_LIMITS = { "x-freebuff-include-unused-rate-limits": "1" };


export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });


    if (request.method === "GET" && url.pathname === "/healthz") {



      return jsonResponse({
        status: "ok",
        version: VERSION,
        ...summarizeAccountHealth(parseAccounts(env), acctHealth),
        health_source: "worker_cache",
        time: new Date().toISOString(),
      }, 200);
    }

    const key = getApiKey(request, env);
    if (!key) {
      if (url.pathname === "/v1/messages" || url.pathname === "/messages" || url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens") {
        return anthropicError("Invalid API key", "authentication_error", 401);
      }
      return jsonResponse({ error: { message: "Invalid API key", type: "auth_error" } }, 401);
    }

    cleanCache();

    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return await handleModels();
    }
    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      return handleChat(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      return handleResponses(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens")) {
      return handleAnthropicCountTokens(request, env);
    }
    if (request.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      return handleAnthropicMessages(request, env);
    }
    return jsonResponse({ error: { message: "Not found", type: "not_found" } }, 404);
  },
};

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

let accountIdx = 0;
const cooldowns = new Map();
const sessCache = new Map();


function parseAccounts(env) {


  return (env.FREEBUFF_TOKEN || "").split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8)
    .map((s) => {
      const idx = s.indexOf(":");
      if (idx > 0) return { token: s.slice(0, idx).trim(), uid: s.slice(idx + 1).trim() || null };
      return { token: s, uid: null };
    })
    .filter((a) => a.token.length > 8);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

const acctHealth = new Map(); // token -> { alive, state, uid, quota, checkedAt }
const HEALTH_OBSERVATION_TTL_MS = 10 * 60 * 1000;



function recordAccountObservation(token, status, dataOrText, extra = {}) {
  if (!token) return;
  let data = dataOrText;
  if (typeof dataOrText === "string") {
    try { data = JSON.parse(dataOrText); } catch { data = null; }
  }
  const upstreamState = data && typeof data === "object" ? data.status || data.state : null;
  let state = null;
  if (status === 404) state = "ok";
  else if (["banned", "country_blocked", "rate_limited", "model_locked", "ip_capped"].includes(upstreamState)) state = upstreamState;
  else if (status >= 200 && status < 300) state = "ok";
  else if (status === 401) state = "token_invalid";
  else if (status === 403) {
    state = upstreamState === "banned"
      ? "banned"
      : upstreamState === "country_blocked" ? "country_blocked" : "blocked";
  } else if (status === 429) state = "rate_limited";
  if (!state) return;

  const previous = acctHealth.get(token) || {};
  acctHealth.set(token, {
    ...previous,
    ...extra,
    alive: state === "ok",
    state,
    uid: extra.uid || previous.uid || null,
    quota: extra.quota || previous.quota || null,
    retryAfterMs: typeof extra.retryAfterMs === "number" ? extra.retryAfterMs : previous.retryAfterMs || null,
    checkedAt: Date.now(),
  });
}

function summarizeAccountHealth(pool, health) {
  const account_details = pool.map((acct) => {
    const info = health.get(acct.token);
    return {
      token: acct.token.slice(0, 8) + "...",
      alive: info ? info.alive : null,
      state: info?.state || "unknown",
      uid: info?.uid ? info.uid.slice(0, 8) + "..." : null,
    };
  });
  const account_states = {};
  for (const detail of account_details) {
    account_states[detail.state] = (account_states[detail.state] || 0) + 1;
  }
  const alive_accounts = account_details.filter((p) => p.alive === true).length;
  const unknown_accounts = account_details.filter((p) => p.alive === null).length;
  const unhealthy_accounts = account_details.filter((p) => p.alive === false).length;
  const status = pool.length === 0
    ? "critical"
    : alive_accounts === 0 && (unhealthy_accounts > 0 || unknown_accounts > 0)
      ? "critical"
      : unhealthy_accounts > 0 || unknown_accounts > 0
        ? "degraded"
        : "ok";
  return {
    status,
    accounts: pool.length,
    alive_accounts,
    unknown_accounts,
    account_states,
    account_details,
  };
}

function pickToken(env, sessionModel) {
  const pool = parseAccounts(env);
  if (pool.length === 0) return null;


  const alivePool = pool.filter((acct) => {
    const h = acctHealth.get(acct.token);
    return !(h && h.alive === false);
  });
  const usePool = alivePool.length > 0 ? alivePool : pool;





  const finalPool = usePool;




  if (sessionModel) {
    for (const acct of finalPool) {
      const t = acct.token;
      if (cooldowns.has(t) && cooldowns.get(t) > Date.now()) continue;
      const cached = sessCache.get(t + ":" + sessionModel);
      if (isUsableSession(cached)) {
        return acct;
      }
    }
  }


  for (let k = 0; k < finalPool.length; k++) {
    const acct = finalPool[accountIdx % finalPool.length];
    accountIdx = (accountIdx + 1) % finalPool.length;
    const t = acct.token;
    if (!cooldowns.has(t) || cooldowns.get(t) <= Date.now()) return acct;
  }
  const oldest = [...cooldowns.entries()].sort((a, b) => a[1] - b[1])[0];
  if (oldest) cooldowns.delete(oldest[0]);
  return finalPool[0];
}

function normalizeSession(data, requestedModel, now = Date.now()) {
  const expiryMs = Date.parse(data?.expiresAt || "");
  const remaining = Number(data?.remainingMs);
  const effectiveExpiry = Number.isFinite(expiryMs)
    ? expiryMs
    : (Number.isFinite(remaining) ? now + Math.max(0, remaining) : NaN);
  return {
    model: data?.model || requestedModel,
    instanceId: data?.instanceId || null,
    remainingMs: Number.isFinite(effectiveExpiry) ? Math.max(0, effectiveExpiry - now) : null,
    expiresAt: Number.isFinite(effectiveExpiry) ? new Date(effectiveExpiry).toISOString() : null,
  };
}

function isUsableSession(session, now = Date.now()) {
  const expiryMs = Date.parse(session?.expiresAt || "");
  return Boolean(session?.instanceId) && Number.isFinite(expiryMs) && expiryMs > now + 60000;
}

function accountSlot(pool, token) {
  const index = pool.findIndex((acct) => acct.token === token);
  return index >= 0 ? `${index + 1}/${pool.length}` : `?/${pool.length}`;
}

function logAccountRoute(enabled, pool, token, model, attempt, reason) {
  if (!enabled) return;
  try {
    console.log(JSON.stringify({ event: "account_route", model, account_slot: accountSlot(pool, token), attempt, reason }));
  } catch {}
}

function cooldown(token, ms) {
  if (ms > 0) cooldowns.set(token, Date.now() + ms);
}

// Official Freebuff session-gate recovery requires matching both the HTTP
// status and the relayed error code. Do not treat session_limit_reached or
// waiting_room_queued as stale sessions: those states must not delete a live
// session or burn another session slot.
const SESSION_GATE_RECOVERY = {
  waiting_room_required: 428,
  session_expired: 410,
  session_superseded: 409,
  session_model_mismatch: 409,
};

function hasExactErrorCode(value, expected) {
  if (value === expected) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((entry) => hasExactErrorCode(entry, expected));
}

function isStaleSessionGate(status, body) {
  let parsed = null;
  try { parsed = JSON.parse(body); } catch {}
  return Object.entries(SESSION_GATE_RECOVERY).some(([code, expectedStatus]) =>
    status === expectedStatus && hasExactErrorCode(parsed, code));
}


function remainingQuota(token, sessionModel) {
  if (modelPoolCategory(sessionModel) === "standard") return null;
  const h = acctHealth.get(token);
  if (!h || !h.quota) return null;
  let entry = h.quota[sessionModel];
  if (!entry && modelPoolCategory(sessionModel) === "premium") {
    const premiumPool = (dynamicModelsCache.pool && dynamicModelsCache.pool.premium)
      ? dynamicModelsCache.pool.premium
      : PREMIUM_QUOTA_MODELS;
    for (const model of premiumPool) {
      if (h.quota[model]) {
        entry = h.quota[model];
        break;
      }
    }
  }
  if (!entry || typeof entry.recentCount !== "number" || typeof entry.limit !== "number") return null;
  return entry.limit - entry.recentCount;
}



function isQuotaExhausted(info, sessionModel) {
  if (!info) return false;
  if (["rate_limited", "banned", "country_blocked", "token_invalid", "blocked", "model_locked", "ip_capped"].includes(info.state)) return true;



  const poolCat = modelPoolCategory(sessionModel);
  if (poolCat === "standard" || poolCat === null) return false;
  if (!info.quota) return false;
  let entry = info.quota[sessionModel];
  if (!entry && modelPoolCategory(sessionModel) === "premium") {
    const premiumPool = (dynamicModelsCache.pool && dynamicModelsCache.pool.premium)
      ? dynamicModelsCache.pool.premium
      : PREMIUM_QUOTA_MODELS;
    for (const model of premiumPool) {
      if (info.quota[model]) { entry = info.quota[model]; break; }
    }
  }
  if (!entry || typeof entry.recentCount !== "number" || typeof entry.limit !== "number") return false;
  return entry.limit - entry.recentCount <= 0;
}

function parseCooldown(text, status) {

  const jm = (text || "").match(/"retryAfterMs"\s*:\s*(\d+)/);
  if (jm) {
    const ms = parseInt(jm[1], 10);
    if (ms > 0) return Math.min(ms, 6 * 3600 * 1000);
  }
  const m = (text || "").match(/try again in (?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i);
  if (m) {
    const ms = (parseInt(m[1]||0,10)*3600 + parseInt(m[2]||0,10)*60 + parseInt(m[3]||0,10)) * 1000;
    if (ms > 0) return Math.min(ms, 6*3600*1000);
  }
  return status === 429 ? 5*60*1000 : 60*1000;
}

class QuotaExhaustedError extends Error {
  constructor(info) {
    super("upstream account quota exhausted");
    this.name = "QuotaExhaustedError";
    this.retryAfterMs = info && typeof info.retryAfterMs === "number" ? info.retryAfterMs : null;
  }
}



class ModelUnavailableError extends Error {
  constructor(modelId, upstreamMessage) {
    super("model unavailable upstream (paused/withdrawn): " + modelId + (upstreamMessage ? " — " + upstreamMessage : ""));
    this.name = "ModelUnavailableError";
    this.modelId = modelId;
  }
}

class EmptyUpstreamStreamError extends Error {
  constructor() {
    super("upstream returned an empty stream");
    this.name = "EmptyUpstreamStreamError";
  }
}

function invalidateSessionCache(token) {
  const prefix = token + ":";
  for (const key of sessCache.keys()) {
    if (key.startsWith(prefix)) sessCache.delete(key);
  }
}

async function deleteUpstreamSession(token, instanceId) {
  invalidateSessionCache(token);
  if (!instanceId) return;
  try {
    await enqueueUp("DELETE", "/api/v1/freebuff/session", token, undefined,
      { "x-freebuff-instance-id": instanceId }, SESSION_TIMEOUT_MS);
  } catch {}
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

let chainTail = Promise.resolve();
const CHAIN_GAP_MS = 300;
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitterSleep() { return sleep(CHAIN_GAP_MS + Math.floor(Math.random() * 1200)); }

function enqueue(fn) {
  const run = chainTail.then(() => jitterSleep()).then(fn);
  chainTail = run.catch(() => {});
  return run;
}

const UPSTREAM_TIMEOUT_MS = 20000;
const NONSTREAM_TIMEOUT_MS = 45000;
const SESSION_TIMEOUT_MS = 10000;


const STREAM_NO_DATA_PROBE_DELAY_MS = 20000;

// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
let outboundFetch = null; // (url, init, token) => Promise<Response>
export function setOutboundFetch(fn) { outboundFetch = fn; }
function doFetch(url, init, token) {
  return outboundFetch ? outboundFetch(url, init, token) : fetch(url, init);
}

async function up(method, path, token, body, extraHeaders = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const headers = {};

  headers["User-Agent"] = SDK_UA;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  Object.assign(headers, extraHeaders);

  const resp = await doFetch(CODEBUFF_API + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  }, token);
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: resp.status, data, text };
}

function enqueueUp(method, path, token, body, extraHeaders, timeoutMs) {
  return enqueue(() => up(method, path, token, body, extraHeaders, timeoutMs));
}







async function freshQuotaProbe(token, sessionModel) {
  const cached = acctHealth.get(token);
  if (!cached) return;
  if (Date.now() - cached.checkedAt > HEALTH_OBSERVATION_TTL_MS) return;
  if (isQuotaExhausted(cached, sessionModel)) throw new QuotaExhaustedError(cached);
}



async function fetchStreamWithQuotaGuard(url, init, token, sessionModel) {
  const controller = new AbortController();
  const request = doFetch(url, { ...init, signal: controller.signal }, token);
  let probeTimer = null;
  const armProbe = () => new Promise((_, reject) => {
    probeTimer = setTimeout(() => {
      freshQuotaProbe(token, sessionModel).catch((error) => {
        if (error instanceof QuotaExhaustedError) {
          try { controller.abort(error); } catch { controller.abort(); }
          reject(error);
        }
      });
    }, STREAM_NO_DATA_PROBE_DELAY_MS);
  });
  const clearProbe = () => {
    if (probeTimer !== null) clearTimeout(probeTimer);
    probeTimer = null;
  };
  try {

    const response = await Promise.race([request, armProbe()]);
    clearProbe();
    if (!response.body) throw new EmptyUpstreamStreamError();

    const reader = response.body.getReader();
    const first = await Promise.race([reader.read(), armProbe()]);
    clearProbe();
    if (first.done) {
      try { reader.releaseLock(); } catch {}
      throw new EmptyUpstreamStreamError();
    }


    const body = new ReadableStream({
      start(streamController) {
        streamController.enqueue(first.value);
        (async () => {
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              streamController.enqueue(next.value);
            }
            streamController.close();
          } catch (error) {
            streamController.error(error);
          } finally {
            try { reader.releaseLock(); } catch {}
          }
        })();
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  } catch (error) {
    clearProbe();
    try { controller.abort(error); } catch { controller.abort(); }
    throw error;
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// cli/src/utils/fingerprint.ts、sdk/src/impl/llm.ts）






// ---------------------------------------------------------------------------
const BEHAVIOR_CACHE_TTL_MS = 30 * 60 * 1000;
const behaviorCache = new Map(); // key -> ts

function behaviorDue(key) {
  const ts = behaviorCache.get(key) || 0;
  if (Date.now() - ts > BEHAVIOR_CACHE_TTL_MS) {
    behaviorCache.set(key, Date.now());
    return true;
  }
  return false;
}






function stableFingerprint(token) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = "freebuff-fp-v2:" + token;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return "enhanced-" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}



function conversationSessionId(token) {
  const window = Math.floor(Date.now() / (30 * 60 * 1000));
  return stableFingerprint(token + "|cs|" + window);
}

async function createSession(token, sessionModel, forceCreate = false) {

  if (!forceCreate) {
    const cached = sessCache.get(token + ":" + sessionModel);
    if (isUsableSession(cached)) {
      return cached;
    }
    if (cached) sessCache.delete(token + ":" + sessionModel);
  }



  if (!forceCreate) {
    const cur = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined,
      DESKTOP_INCLUDE_RATE_LIMITS, SESSION_TIMEOUT_MS);
    recordAccountObservation(token, cur.status, cur.data, {
      quota: cur.data?.rateLimitsByModel || null,
      uid: cur.data?.uid || null,
      retryAfterMs: cur.data?.retryAfterMs,
    });
    if (cur.status === 200 && cur.data?.status === "active" && cur.data?.instanceId) {
      const cm = cur.data.model;
      if (!cm || cm === sessionModel) {
        const s = normalizeSession(cur.data, sessionModel);
        sessCache.set(token + ":" + sessionModel, s);
        return s;
      }
      await deleteUpstreamSession(token, cur.data.instanceId);
    }
  }











  let modelUnlockRetried = false;
  let r = null;
  for (;;) {
    const instId = crypto.randomUUID();
    r = await enqueueUp("POST", "/api/v1/freebuff/session", token, undefined,
      { "x-freebuff-model": sessionModel, "x-freebuff-instance-id": instId, "Content-Type": "application/json" }, SESSION_TIMEOUT_MS);
    recordAccountObservation(token, r.status, r.data, {
      quota: r.data?.rateLimitsByModel || null,
      uid: r.data?.uid || null,
      retryAfterMs: r.data?.retryAfterMs,
    });
    if (r.status === 200 && r.data?.status === "active" && r.data?.instanceId) {
      const s = normalizeSession(r.data, sessionModel);
      sessCache.set(token + ":" + sessionModel, s);
      return s;
    }
    if (r.status === 200 && r.data?.status === "queued" && r.data?.instanceId) {
      const inst = r.data.instanceId;
      for (let i = 0; i < 8; i++) {
        await sleep(1500);
        const q = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined, { "x-freebuff-instance-id": inst }, SESSION_TIMEOUT_MS);
        recordAccountObservation(token, q.status, q.data, {
          quota: q.data?.rateLimitsByModel || null,
          uid: q.data?.uid || null,
          retryAfterMs: q.data?.retryAfterMs,
        });
        if (q.status === 200 && q.data?.status === "active") {
          const s = normalizeSession({ ...q.data, instanceId: q.data.instanceId || inst }, sessionModel);
          sessCache.set(token + ":" + sessionModel, s);
          return s;
        }
      }
      throw new Error("session stayed queued (retry later)");
    }
    const mismatchMsg = "session_model_mismatch: " + String(r.data?.message || r.data?.error || "Upstream rejected this model");
    if (r.status === 409 && !modelUnlockRetried) {
      modelUnlockRetried = true;
      const cur = await enqueueUp("GET", "/api/v1/freebuff/session", token, undefined,
        DESKTOP_INCLUDE_RATE_LIMITS, SESSION_TIMEOUT_MS);
      recordAccountObservation(token, cur.status, cur.data, {
        quota: cur.data?.rateLimitsByModel || null,
        uid: cur.data?.uid || null,
        retryAfterMs: cur.data?.retryAfterMs,
      });
      if (cur.status === 200 && cur.data?.instanceId) {
        if (typeof process !== "undefined" && process.env && process.env.FREEBUFF_DEBUG === "true") console.log(`[session] 409 model_locked, releasing ${cur.data.instanceId} (model=${cur.data.model || "?"}) then retry POST`);
        await deleteUpstreamSession(token, cur.data.instanceId);
        continue;
      }

      throw new Error(mismatchMsg);
    }
    if (r.status === 409) throw new Error(mismatchMsg);
    break;
  }


  if (r.status === 410 || hasExactErrorCode(r.data, "model_unavailable")) {
    throw new ModelUnavailableError(sessionModel, String((r.data && (r.data.message || r.data.error)) || r.text || "").slice(0, 200));
  }
  throw new Error("create session failed: " + r.status + " " + (r.text || "").slice(0, 300));
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

function utcNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function startRun(token, agentId, ancestors = []) {
  const r = await enqueueUp("POST", "/api/v1/agent-runs", token,
    { action: "START", agentId, ancestorRunIds: ancestors }, undefined, SESSION_TIMEOUT_MS);
  if (r.status !== 200 || !r.data?.runId) throw new Error("start_run failed: " + r.status + " " + (r.text || "").slice(0, 200));
  return r.data.runId;
}

async function recordStep(token, runId, stepNumber, startTime, children = [], messageId = null) {
  await enqueueUp("POST", `/api/v1/agent-runs/${runId}/steps`, token,
    { stepNumber, credits: 0, childRunIds: children, messageId, status: "completed", startTime }, undefined, SESSION_TIMEOUT_MS);
}

async function finishRun(token, runId, totalSteps) {
  await enqueueUp("POST", "/api/v1/agent-runs", token,
    { action: "FINISH", runId, status: "completed", totalSteps, directCredits: 0, totalCredits: 0 }, undefined, SESSION_TIMEOUT_MS);
}




const runCache = new Map();   // `${token}:${agentId}` -> { runId, childRunId, ts }
const RUN_CACHE_TTL_MS = 10 * 60 * 1000;

async function startRunChain(token, agentId) {
  const key = token + ":" + agentId;
  const hit = runCache.get(key);
  if (hit && Date.now() - hit.ts < RUN_CACHE_TTL_MS) {
    return { runId: hit.runId, agentId, startedAt: utcNow(), childRunId: hit.childRunId, cached: true };
  }
  const startedAt = utcNow();
  const runId = await startRun(token, agentId);
  const childRunId = await startRun(token, CONTEXT_PRUNER_AGENT, [runId]);
  runCache.set(key, { runId, childRunId, ts: Date.now() });
  return { runId, agentId, startedAt, childRunId, cached: false };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

const UPSTREAM_KEYS = [
  "frequency_penalty", "logit_bias", "logprobs", "max_completion_tokens", "max_tokens",
  "metadata", "modalities", "parallel_tool_calls", "presence_penalty", "reasoning_effort",
  "response_format", "seed", "service_tier", "stop", "store", "stream_options",
  "temperature", "tool_choice", "tools", "top_logprobs", "top_p", "top_k", "user",
];




const BUFFY = "You are Buffy, the strategic coding assistant.";

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  let hasSystem = false;
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const item = { ...m };
    if (item.role === "developer") item.role = "system";
    if (item.role === "system") {
      hasSystem = true;
      item.cache_control = { type: "ephemeral" };


      if (typeof item.content === "string") {
        if (!item.content.startsWith(BUFFY)) item.content = BUFFY + item.content;
      } else if (Array.isArray(item.content)) {
        const firstText = item.content.find((c) => c && c.type === "text" && typeof c.text === "string");
        if (firstText && !firstText.text.startsWith(BUFFY)) firstText.text = BUFFY + firstText.text;
      }
    }
    out.push(item);
  }
  if (!hasSystem) out.unshift({ role: "system", content: BUFFY, cache_control: { type: "ephemeral" } });
  return out;
}





const REASONING_EFFORT_RANK = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];



//   - deepseek-v4-pro:   [high, max]
//   - gpt-5.6-luna:      EFFORTS_THROUGH_MAX（low..max）
//   - muse-spark:        EFFORTS_THROUGH_XHIGH（low..xhigh，ALWAYS reasons，none=400）


const MODEL_EFFORTS = {
  "deepseek/deepseek-v4-flash": ["low", "high", "max"],
  "deepseek/deepseek-v4-pro": ["high", "max"],
  "openai/gpt-5.6-luna": ["low", "medium", "high", "max"],
  "meta/muse-spark-1.2-contributor": ["low", "medium", "high", "xhigh"],
};

function clampReasoningEffort(requested, allowed) {
  if (!Array.isArray(allowed) || allowed.length === 0) return requested;
  const wanted = REASONING_EFFORT_RANK.indexOf(requested);
  if (wanted < 0) return requested;
  let best = null;
  let bestRank = -1;
  for (const cand of allowed) {
    const rank = REASONING_EFFORT_RANK.indexOf(cand);
    if (rank < 0 || rank > wanted) continue;
    if (rank > bestRank) { best = cand; bestRank = rank; }
  }
  if (best !== null) return best;

  return allowed.reduce((lo, c) =>
    REASONING_EFFORT_RANK.indexOf(c) < REASONING_EFFORT_RANK.indexOf(lo) ? c : lo);
}

function normalizeReasoningEffort(model, effort) {
  if (effort === undefined || effort === null) return effort;
  const allowed = MODEL_EFFORTS[model];
  if (!allowed) return effort;
  const clamped = clampReasoningEffort(String(effort), allowed);
  return clamped === String(effort) ? effort : clamped;
}

function buildUpstreamPayload(params, mc, sess, runId, token) {
  const payload = {};
  for (const k of UPSTREAM_KEYS) if (params[k] !== undefined && params[k] !== null) payload[k] = params[k];

  if (payload.reasoning_effort !== undefined) {
    payload.reasoning_effort = normalizeReasoningEffort(mc.id, payload.reasoning_effort);
  }
  payload.model = mc.upstream;
  payload.messages = normalizeMessages(params.messages);
  payload.stream = true;
  if (!payload.stop) payload.stop = ['"cb_easp"'];
  payload.provider = { data_collection: "deny" };




  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    const hasSignature = payload.tools.some(
      (t) => t && typeof t === "object" && t.function && typeof t.function.name === "string" && t.function.name === "end_turn",
    );
    if (!hasSignature) {
      payload.tools = [
        ...payload.tools,
        { type: "function", function: { name: "end_turn", description: "Signal the end of the current task.", parameters: { type: "object", properties: {} } } },
      ];
    }
  }
  payload.codebuff_metadata = {
    freebuff_instance_id: sess.instanceId,
    trace_session_id: crypto.randomUUID(),
    run_id: runId,


    client_id: conversationSessionId(token),
    cost_mode: "free",
  };
  return payload;
}



function isCodeReviewRequest(params) {
  return params && params.metadata && params.metadata.freebuff_mode === "code_review";
}

function buildReviewerMessages(params) {
  const messages = Array.isArray(params.messages)
    ? params.messages.map((m) => ({ ...m }))
    : [];

  messages.unshift({
    role: "system",
    content: "You are a subagent that reviews code changes and gives helpful critical feedback. Do not use any tools. Review the last file changes made by the assistant. Focus on missing requirements, correctness, regressions, dead code, missing imports, and consistency with the existing code. Be extremely concise and only suggest changes; do not modify files.",
  });
  const requestedPrompt = params.metadata && typeof params.metadata.freebuff_review_prompt === "string"
    ? params.metadata.freebuff_review_prompt.trim()
    : "";
  messages.push({
    role: "user",
    content: requestedPrompt ||
      "Review the recent code changes in the conversation. Give concise, critical feedback only.",
  });
  return messages;
}

function buildReviewerPayload(params, mc, sess, reviewerRunId, token) {
  const metadata = params.metadata && typeof params.metadata === "object"
    ? { ...params.metadata }
    : undefined;
  if (metadata) {
    delete metadata.freebuff_mode;
    delete metadata.freebuff_review_prompt;
  }
  return buildUpstreamPayload(
    {
      ...params,
      metadata,
      messages: buildReviewerMessages(params),

      tools: undefined,
      tool_choice: undefined,
      parallel_tool_calls: undefined,
    },
    mc,
    sess,
    reviewerRunId,
    token,
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------


function findModelConfig(modelId) {
  const hit = MODELS.find((m) => m.id === modelId);
  if (hit) return hit;
  const dyn = dynamicModelsCache.models;
  if (dyn) {
    const d = dyn.find((m) => m.id === modelId);
    if (d) return d;
  }
  return null;
}



async function resolveModelConfig(modelId) {
  if (isPausedModel(modelId)) return null;
  let hit = findModelConfig(modelId);
  if (hit) return hit;
  try {
    const dyn = await refreshDynamicModelsIfStale();
    if (dyn && dyn.models) {
      hit = dyn.models.find((m) => m.id === modelId) || null;
      if (hit) return hit;
    }
  } catch {}
  return findModelConfig(modelId);
}

async function handleChat(request, env) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  const isStream = !!params.stream;
  const requestedModel = params.model || DEFAULT_MODEL;
  const mc = await resolveModelConfig(requestedModel);
  if (!mc) return jsonResponse({ error: { message: "Model not available: " + requestedModel, type: "unsupported_model" } }, 400);
  return executeChat(env, params, mc, isStream, "chat");
}


async function handleResponses(request, env) {
  let params;
  try { params = await request.json(); } catch { return jsonResponse({ error: { message: "Invalid JSON", type: "parse_error" } }, 400); }
  const isStream = !!params.stream;
  const requestedModel = params.model || DEFAULT_MODEL;
  const mc = await resolveModelConfig(requestedModel);
  if (!mc) return jsonResponse({ error: { message: "Model not available: " + requestedModel, type: "unsupported_model" } }, 400);
  return executeChat(env, responsesToChatParams(params, mc), mc, isStream, "responses");
}


function responsesToChatParams(params, mc) {
  const chat = {};
  for (const k of ["temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "stop", "seed", "store", "metadata", "user", "stream"]) {
    if (params[k] !== undefined && params[k] !== null) chat[k] = params[k];
  }
  if (params.max_output_tokens !== undefined && params.max_output_tokens !== null) chat.max_completion_tokens = params.max_output_tokens;
  if (params.reasoning && typeof params.reasoning === "object" && params.reasoning.effort) chat.reasoning_effort = params.reasoning.effort;
  if (params.text && typeof params.text === "object" && params.text.format && params.text.format.type && params.text.format.type !== "text") {
    chat.response_format = { type: params.text.format.type };
    if (params.text.format.json_schema) chat.response_format.json_schema = params.text.format.json_schema;
  }


  if (Array.isArray(params.tools)) {
    chat.tools = params.tools
      .filter((t) => t && typeof t === "object" && t.type === "function")
      .map((t) => ({
        type: "function",
        function: {
          name: t.name || "",
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {} },
        },
      }));
    if (chat.tools.length === 0) delete chat.tools;
  }

  if (params.tool_choice && typeof params.tool_choice === "object") {
    if (params.tool_choice.type === "function" && params.tool_choice.name) {
      chat.tool_choice = { type: "function", function: { name: params.tool_choice.name } };
    } else {
      chat.tool_choice = "auto";
    }
  }
  chat.model = mc.id;
  chat.messages = responsesInputToMessages(params.input, params.instructions);
  return chat;
}


function responsesInputToMessages(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  if (typeof input === "string") { messages.push({ role: "user", content: input }); return messages; }
  if (!Array.isArray(input)) { messages.push({ role: "user", content: input == null ? "" : String(input) }); return messages; }
  for (const item of input) {
    if (typeof item === "string") { messages.push({ role: "user", content: item }); continue; }
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id || "", content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
      continue;
    }

    if (item.type === "function_call" || item.type === "reasoning" || item.type === "item_reference") continue;
    const role = item.role || "user";
    const content = item.content;
    if (typeof content === "string") { messages.push({ role, content }); continue; }
    if (Array.isArray(content)) {
      const parts = [];
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "input_text" || c.type === "output_text") { parts.push({ type: "text", text: c.text ?? "" }); continue; }
        if (c.type === "text" && typeof c.text === "string") { parts.push(c); continue; }
      }
      messages.push({ role, content: parts.length ? parts : "" });
      continue;
    }
    messages.push({ role, content: "" });
  }
  return messages;
}




async function executeCodeReview(env, chatParams, mc, isStream, mode) {
  const debug = env.FREEBUFF_DEBUG === "true";
  const reviewerAgent = mc.reviewer_agent;
  const reviewerModel = mc.upstream;
  if (!reviewerAgent) {
    return jsonResponse({
      error: {
        message: "Code review is not available for model: " + mc.id,
        type: "unsupported_review_agent",
      },
    }, 400);
  }

  const pool = parseAccounts(env);
  if (pool.length === 0) {
    return jsonResponse({ error: { message: "Missing FREEBUFF_TOKEN environment variable", type: "config_error" } }, 503);
  }

  let lastErrMsg = "";
  for (let acctTry = 0; acctTry < pool.length; acctTry++) {
    const acct = pickToken(env, mc.session);
    const token = acct ? acct.token : null;
    if (!token) break;
    logAccountRoute(debug, pool, token, mc.session, acctTry + 1,
      isUsableSession(sessCache.get(token + ":" + mc.session)) ? "active_session" : "quota_or_round_robin");
    let rootRunId = null;
    let reviewerRunId = null;
    try {
      const sess = await createSession(token, mc.session);
      const root = await startRunChain(token, mc.root_agent || mc.agent);
      rootRunId = root.runId;

      reviewerRunId = await startRun(token, reviewerAgent, [rootRunId]);
      if (debug) console.log(`[review][acct ${acctTry + 1}] root=${rootRunId} reviewer=${reviewerRunId} model=${reviewerModel}`);

      const payload = buildReviewerPayload(chatParams, { ...mc, upstream: reviewerModel }, sess, reviewerRunId, token);
      const headers = {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "x-freebuff-instance-id": sess.instanceId,
      };
      const resp = await doFetch(CODEBUFF_API + "/api/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: isStream ? undefined : AbortSignal.timeout(NONSTREAM_TIMEOUT_MS),
      }, token);
      if (!resp.ok) {
        const text = await resp.text();
        recordAccountObservation(token, resp.status, text);
        lastErrMsg = "reviewer upstream error: " + text.slice(0, 300);
        cooldown(token, parseCooldown(text, resp.status));
        throw new Error(lastErrMsg);
      }

      let finalized = false;
      const finalize = async () => {
        if (finalized) return;
        finalized = true;
        if (reviewerRunId) await finishRun(token, reviewerRunId, 1).catch(() => {});
        if (rootRunId) await finishRun(token, rootRunId, 1).catch(() => {});
      };

      if (isStream) {
        const { readable, writable } = new TransformStream();
        if (mode === "responses") pipeUpstreamToResponsesStream(resp.body, writable, mc, finalize);
        else pipeUpstreamToClient(resp.body, writable, finalize);
        return new Response(readable, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() },
        });
      }

      const result = mode === "responses"
        ? await responsesToNonStream(resp.body, mc)
        : await streamToNonStream(resp.body, reviewerModel);
      await finalize();
      return mode === "responses" ? jsonResponse(result, 200) : jsonResponse(result, 200);
    } catch (e) {
      console.error("[code_review]", e);

      if (e instanceof ModelUnavailableError) {
        return jsonResponse({ error: { message: "Model not available upstream: " + e.modelId + " (this model has been removed or paused upstream)", type: "unsupported_model" } }, 400);
      }
      lastErrMsg = String(e.message || e);
      if (reviewerRunId) await finishRun(token, reviewerRunId, 1).catch(() => {});
      if (rootRunId) await finishRun(token, rootRunId, 1).catch(() => {});
      if (/start_run failed|timeout|timed out|abort|reviewer upstream/i.test(lastErrMsg)) cooldown(token, 60 * 1000);
    }
  }
  return jsonResponse({ error: { message: lastErrMsg || "code reviewer failed", type: "api_error" } }, 502);
}


async function executeChat(env, chatParams, mc, isStream, mode) {
  if (isCodeReviewRequest(chatParams)) return executeCodeReview(env, chatParams, mc, isStream, mode);
  const debug = env.FREEBUFF_DEBUG === "true";
  const pool = parseAccounts(env);
  if (pool.length === 0) return jsonResponse({ error: { message: "Missing FREEBUFF_TOKEN environment variable", type: "config_error" } }, 503);



  let lastErrMsg = "";
  for (let acctTry = 0; acctTry < pool.length; acctTry++) {
    const acct = pickToken(env, mc.session);
    const token = acct ? acct.token : null;
    if (!token) break;
    logAccountRoute(debug, pool, token, mc.session, acctTry + 1,
      isUsableSession(sessCache.get(token + ":" + mc.session)) ? "active_session" : "quota_or_round_robin");
    try {
      // 1) session
      const sess = await createSession(token, mc.session);
      if (debug) console.log(`[acct ${acctTry + 1}] session=${sess.instanceId}`);


      const run = await startRunChain(token, mc.agent);
      if (debug) console.log(`[acct ${acctTry + 1}] run=${run.runId}`);



      let resp, errText = "", sessForChat = sess;
      for (let attempt = 0; attempt < 2; attempt++) {
        const payload = buildUpstreamPayload(chatParams, mc, sessForChat, run.runId, token);
        const headers = {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "x-freebuff-instance-id": sessForChat.instanceId,
        };


        // this session. Only one instance per account is allowed."）。



        if (debug) console.log(`[acct ${acctTry + 1}][chat] attempt=${attempt + 1}`);
        const chatInit = {
          method: "POST", headers, body: JSON.stringify(payload),
        };
        try {
          resp = isStream
            ? await fetchStreamWithQuotaGuard(CODEBUFF_API + "/api/v1/chat/completions", chatInit, token, mc.session)
            : await doFetch(CODEBUFF_API + "/api/v1/chat/completions", {
                ...chatInit,
                signal: AbortSignal.timeout(NONSTREAM_TIMEOUT_MS),
              }, token);
        } catch (error) {


          if (error instanceof EmptyUpstreamStreamError && attempt === 0) {
            await deleteUpstreamSession(token, sessForChat.instanceId);
            if (debug) console.log(`[acct ${acctTry + 1}][chat] empty stream, same-model session recovery`);
            sessForChat = await createSession(token, mc.session, true);
            continue;
          }
          throw error;
        }
        if (resp.ok) {
          recordAccountObservation(token, resp.status, null);
          break;
        }
        errText = await resp.text();
        recordAccountObservation(token, resp.status, errText);

        let parsedErr = null;
        try { parsedErr = JSON.parse(errText); } catch {}
        if (resp.status === 410 || hasExactErrorCode(parsedErr, "model_unavailable")) {
          throw new ModelUnavailableError(mc.session, errText.slice(0, 200));
        }


        const staleSession =
          isStaleSessionGate(resp.status, errText) ||
          // Older upstream wrappers returned model mismatch as HTTP 502.
          (resp.status === 502 && (errText.includes("session_model_mismatch") || errText.includes("not valid for limited access")));
        if (staleSession && attempt === 0) {
          await deleteUpstreamSession(token, sessForChat.instanceId);
          if (debug) console.log(`[acct ${acctTry + 1}][chat] session stale (${resp.status}), recreate…`);
          sessForChat = await createSession(token, mc.session, true);
          continue;
        }

        if (staleSession) cooldown(token, 60 * 1000);
        cooldown(token, parseCooldown(errText, resp.status));
        break;
      }
      if (!resp.ok) {
        lastErrMsg = "upstream error: " + (errText || "").slice(0, 300);
        if (debug) console.log(`[acct ${acctTry + 1}] failed ${resp.status}, switch account`);
        continue;
      }

      if (isStream) {
        const { readable, writable } = new TransformStream();
        if (mode === "responses") pipeUpstreamToResponsesStream(resp.body, writable, mc);
        else pipeUpstreamToClient(resp.body, writable);
        return new Response(readable, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() } });
      }

      if (mode === "responses") return jsonResponse(await responsesToNonStream(resp.body, mc), 200);

      const agg = await streamToNonStream(resp.body, mc.upstream);
      return jsonResponse(agg, 200);
    } catch (e) {
      console.error("[" + mode + "]", e);
      const msg = String(e.message || e);

      if (e instanceof ModelUnavailableError) {
        return jsonResponse({ error: { message: "Model not available upstream: " + e.modelId + " (this model has been removed or paused upstream)", type: "unsupported_model" } }, 400);
      }

      if (e instanceof QuotaExhaustedError) {
        sessCache.delete(token + ":" + mc.session);
        cooldown(token, e.retryAfterMs || 5 * 60 * 1000);
      }
      if (e instanceof EmptyUpstreamStreamError) {
        cooldown(token, 60 * 1000);
      }


      if (/create session failed|stayed queued|start_run failed|session_model_mismatch|abort|timeout|timed out|terminated/i.test(msg)) {
        const m429 = msg.match(/429/);
        cooldown(token, m429 ? parseCooldown(msg, 429) : 60 * 1000);
      }
      lastErrMsg = msg;
      if (debug) console.log(`[acct ${acctTry + 1}] exception: ${msg.slice(0, 120)}, switch account`);
    }
  }
  return jsonResponse({ error: { message: lastErrMsg, type: "api_error" } }, 502);
}


// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
function anthropicModelToOpenAI(model) {
  const raw = String(model || DEFAULT_MODEL).trim();
  if (findModelConfig(raw)) return raw;
  const short = raw.replace(/^anthropic\//, "");
  const hit = MODELS.find((m) => m.id.toLowerCase().endsWith("/" + short.toLowerCase()));
  return hit ? hit.id : DEFAULT_MODEL;
}

function anthropicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
}

function anthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") out.push({ type: "text", text: p.text });
    if (p.type === "image" && p.source && typeof p.source === "object") {
      const s = p.source;
      if (s.type === "base64" && s.media_type && s.data) out.push({ type: "image_url", image_url: { url: `data:${s.media_type};base64,${s.data}` } });
      else if (s.type === "url" && s.url) out.push({ type: "image_url", image_url: { url: s.url } });
    }
  }
  return out;
}

function anthropicToChat(body, mc) {
  const chat = { model: mc.id, stream: !!body.stream, messages: [] };
  if (body.stream) chat.stream_options = { include_usage: true };
  const system = anthropicText(body.system);
  if (system) chat.messages.push({ role: "system", content: system });
  if (body.max_tokens != null) chat.max_completion_tokens = body.max_tokens;
  for (const k of ["temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty"]) if (body[k] != null) chat[k] = body[k];
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) chat.stop = body.stop_sequences;
  if (body.thinking?.type === "enabled" && Number.isFinite(body.thinking.budget_tokens)) {


    chat.reasoning_effort = body.thinking.budget_tokens >= 16000 ? "high" : body.thinking.budget_tokens >= 8000 ? "medium" : "low";
  }
  if (body.metadata && typeof body.metadata === "object") chat.metadata = body.metadata;

  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = body.tools.filter((t) => t && t.name).map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
    const tc = body.tool_choice;
    if (tc?.type === "auto") chat.tool_choice = "auto";
    else if (tc?.type === "any") chat.tool_choice = "required";
    else if (tc?.type === "none") chat.tool_choice = "none";
    else if (tc?.type === "tool" && tc.name) chat.tool_choice = { type: "function", function: { name: tc.name } };
  }

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") {
      const parts = Array.isArray(m.content) ? m.content : [];
      const results = parts.filter((p) => p && p.type === "tool_result");
      if (results.length) {
        for (const p of results) chat.messages.push({ role: "tool", tool_call_id: p.tool_use_id || "", content: anthropicContent(p.content) });
        const text = parts.filter((p) => p && p.type === "text" && p.text).map((p) => p.text).join("\n");
        if (text) chat.messages.push({ role: "user", content: text });
      } else chat.messages.push({ role: "user", content: anthropicContent(m.content) });
    } else if (m.role === "assistant") {
      const uses = Array.isArray(m.content) ? m.content.filter((p) => p && p.type === "tool_use") : [];
      if (uses.length) chat.messages.push({ role: "assistant", content: anthropicText(m.content), tool_calls: uses.map((p) => ({ id: p.id || ("call_" + Math.random().toString(36).slice(2, 10)), type: "function", function: { name: p.name || "", arguments: JSON.stringify(p.input ?? {}) } })) });
      else chat.messages.push({ role: "assistant", content: anthropicText(m.content) });
    }
  }
  return chat;
}

function anthropicStopReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function anthropicFromChat(oai, mc) {
  const choice = oai?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: tc.id || ("toolu_" + Math.random().toString(36).slice(2, 10)), name: tc.function?.name || "", input });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const u = oai?.usage || {};
  return { id: oai?.id || ("msg_" + Math.random().toString(36).slice(2, 10)), type: "message", role: "assistant", model: mc.id, content, stop_reason: anthropicStopReason(choice.finish_reason), stop_sequence: null, usage: { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0 } };
}

function anthropicError(message, type, status, retryAfter) {
  const headers = { ...corsHeaders() };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  return jsonResponse({ type: "error", error: { type: type || "api_error", message: String(message || "Upstream error") } }, status || 500, headers);
}

function estimateAnthropicTokens(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n, x) => n + estimateAnthropicTokens(x), 0);
  if (value && typeof value === "object") return Object.entries(value).reduce((n, [k, v]) => n + k.length + estimateAnthropicTokens(v), 0);
  return 0;
}

async function handleAnthropicCountTokens(request, env) {
  let body;
  try { body = await request.json(); } catch { return anthropicError("Invalid JSON", "invalid_request_error", 400); }
  const openaiModel = anthropicModelToOpenAI(body.model);
  const mc = findModelConfig(openaiModel);
  if (!mc) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  const chat = anthropicToChat(body, mc);
  return jsonResponse({ input_tokens: Math.max(1, Math.ceil(estimateAnthropicTokens(chat.messages) / 4)) }, 200);
}

function anthropicStream(mc) {
  const decoder = new TextDecoder();
  let buffer = "", started = false, ended = false, block = null, blockIndex = -1, reason = "end_turn", input = 0, output = 0;
  const encoder = new TextEncoder();
  const events = (ctl, name, data) => { if (!data.type) data.type = name; ctl.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)); };
  const close = (ctl) => { if (block) { events(ctl, "content_block_stop", { index: block.index }); block = null; } };
  const end = (ctl) => {
    if (ended) return; ended = true;
    if (!started) events(ctl, "message_start", { message: { id: "msg_" + Math.random().toString(36).slice(2, 10), type: "message", role: "assistant", model: mc.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } } });
    close(ctl);
    events(ctl, "message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } });
    events(ctl, "message_stop", {});
  };
  return new TransformStream({
    transform(chunk, ctl) {
      if (ended) return;
      buffer += decoder.decode(chunk, { stream: true });
      let pos;
      while ((pos = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, pos).trim(); buffer = buffer.slice(pos + 1);
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") { end(ctl); continue; }
        let obj; try { obj = JSON.parse(raw); } catch { continue; }
        if (obj.usage) { input = obj.usage.prompt_tokens ?? input; output = obj.usage.completion_tokens ?? output; }
        const choice = obj.choices?.[0]; if (!choice) continue;
        const delta = choice.delta || {};
        if (!started) { started = true; events(ctl, "message_start", { message: { id: "msg_" + Math.random().toString(36).slice(2, 10), type: "message", role: "assistant", model: mc.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0 } } }); }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const fn = tc.function || {}; const idx = tc.index ?? 0;
            if (!block || block.kind !== "tool" || block.sourceIndex !== idx) { close(ctl); block = { index: ++blockIndex, kind: "tool", sourceIndex: idx }; events(ctl, "content_block_start", { index: block.index, content_block: { type: "tool_use", id: tc.id || ("toolu_" + Math.random().toString(36).slice(2, 10)), name: fn.name || "", input: {} } }); }
            if (fn.arguments) events(ctl, "content_block_delta", { index: block.index, delta: { type: "input_json_delta", partial_json: fn.arguments } });
          }
        } else if (delta.content) {
          if (!block || block.kind !== "text") { close(ctl); block = { index: ++blockIndex, kind: "text" }; events(ctl, "content_block_start", { index: block.index, content_block: { type: "text", text: "" } }); }
          events(ctl, "content_block_delta", { index: block.index, delta: { type: "text_delta", text: delta.content } });
        }
        if (choice.finish_reason) reason = anthropicStopReason(choice.finish_reason);
      }
    },
    flush(ctl) { end(ctl); },
  });
}

async function handleAnthropicMessages(request, env) {
  let body;
  try { body = await request.json(); } catch { return anthropicError("Invalid JSON", "invalid_request_error", 400); }
  const openaiModel = anthropicModelToOpenAI(body.model);
  const mc = findModelConfig(openaiModel);
  if (!mc) return anthropicError("Model not available: " + (body.model || ""), "invalid_request_error", 400);
  const chat = anthropicToChat(body, mc);
  const response = await executeChat(env, chat, mc, !!chat.stream, "chat");
  if (response.status >= 400) {
    let msg = "Upstream error"; try { const data = await response.json(); msg = data?.error?.message || msg; } catch {}
    const types = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 429: "rate_limit_error", 503: "overloaded_error" };
    return anthropicError(msg, types[response.status] || "api_error", response.status, response.headers.get("Retry-After"));
  }
  if (!chat.stream) return jsonResponse(anthropicFromChat(await response.json(), mc), response.status);
  return new Response(response.body.pipeThrough(anthropicStream(mc)), { status: response.status, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...corsHeaders() } });
}



function unwrapData(obj) {
  if (obj && obj.data && typeof obj.data === "object" && (obj.data.choices || obj.data.id || obj.data.usage)) return obj.data;
  return obj;
}


function pipeUpstreamToClient(upstreamBody, writable, onComplete) {
  const reader = upstreamBody.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") { await writer.write(encoder.encode(line + "\n\n")); continue; }
            try {
              const normalized = unwrapData(JSON.parse(payload));
              await writer.write(encoder.encode("data: " + JSON.stringify(normalized) + "\n\n"));
            } catch { await writer.write(encoder.encode(line + "\n")); }
          } else {
            await writer.write(encoder.encode(line + "\n"));
          }
        }
      }
    } catch {}
    finally {
      try { if (onComplete) await onComplete(); } catch {}
      try { await writer.close(); } catch {}
    }
  })();
}


async function streamToNonStream(upstreamBody, upstreamModel) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", reasoning = "", finishReason = null, model = "", id = "", usage = null;
  const toolCalls = new Map();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = unwrapData(JSON.parse(payload));
        const choice = obj?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) content += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== "object") continue;
            const ti = tc.index ?? 0;
            let item = toolCalls.get(ti);
            if (!item) { item = { id: "", name: "", arguments: "" }; toolCalls.set(ti, item); }
            if (tc.id) item.id = tc.id;
            const fn = tc.function || {};
            if (fn.name && !item.name) item.name = fn.name;
            if (fn.arguments) item.arguments += fn.arguments;
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (obj.id) id = obj.id;
        if (obj.model) model = obj.model;
        if (obj.usage) usage = obj.usage;
      } catch {}
    }
  }
  const msg = { role: "assistant", content };
  if (toolCalls.size) {
    msg.tool_calls = [...toolCalls.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => ({
      id: v.id || ("call_" + Math.random().toString(36).slice(2, 10)),
      type: "function",
      function: { name: v.name, arguments: v.arguments },
    }));
  }
  if (reasoning && !content) { msg.content = reasoning; msg.reasoning_used_as_content = true; }
  else if (reasoning) msg.reasoning_content = reasoning;
  return {
    id: id || "gen_" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || upstreamModel,
    choices: [{ index: 0, message: msg, finish_reason: finishReason || "stop", logprobs: null }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

function responsesBase(mc, respId, createdAt) {
  return {
    id: respId || "resp_" + Math.random().toString(36).slice(2, 10),
    object: "response",
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
    status: "in_progress",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: mc.id,
    output: [],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1.0,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1.0,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  };
}

function responsesUsage() {
  return { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 };
}



function chatUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return responsesUsage();
  const inputTokens = Number.isFinite(usage.input_tokens)
    ? usage.input_tokens
    : Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputTokens = Number.isFinite(usage.output_tokens)
    ? usage.output_tokens
    : Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  const totalTokens = Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : inputTokens + outputTokens;
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details : {};
  const outputDetails = usage.output_tokens_details && typeof usage.output_tokens_details === "object"
    ? usage.output_tokens_details : {};
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: Number.isFinite(inputDetails.cached_tokens) ? inputDetails.cached_tokens : 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: Number.isFinite(outputDetails.reasoning_tokens) ? outputDetails.reasoning_tokens : 0 },
    total_tokens: totalTokens,
  };
}


async function pipeUpstreamToResponsesStream(upstreamBody, writable, mc, onComplete) {
  const reader = upstreamBody.getReader();
  const writer = writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const respId = "resp_" + Math.random().toString(36).slice(2, 10);
  const createdAt = Math.floor(Date.now() / 1000);
  let buf = "", model = "", usage = null;
  const send = (obj) => writer.write(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));


  const items = [];
  let nextOutputIndex = 0;
  let contentItem = null;
  const toolItems = new Map();

  const startContent = () => {
    const item = {
      kind: "message",
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      outputIndex: nextOutputIndex++,
      text: "",
      contentIndex: 0,
      started: false,
    };
    items.push(item);
    return item;
  };
  const startTool = (tc) => {
    const fn = tc.function || {};
    const item = {
      kind: "function_call",
      id: "fc_" + Math.random().toString(36).slice(2, 10),
      outputIndex: nextOutputIndex++,
      callId: tc.id || "call_" + Math.random().toString(36).slice(2, 10),
      name: fn.name || "",
      args: "",
    };
    items.push(item);
    return item;
  };

  (async () => {
    try {
      await send({ type: "response.created", response: responsesBase(mc, respId, createdAt) });
      await send({ type: "response.in_progress", response: responsesBase(mc, respId, createdAt) });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          try {
            const obj = unwrapData(JSON.parse(payload));
            const choice = obj?.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta || {};
                if (obj.model) model = obj.model;
                if (obj.usage) usage = obj.usage;


            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                if (!tc || typeof tc !== "object") continue;
                const ti = tc.index ?? 0;
                let item = toolItems.get(ti);
                if (!item) {
                  item = startTool(tc);
                  toolItems.set(ti, item);
                  await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "in_progress", call_id: item.callId, name: item.name, arguments: "" } });
                }
                const fn = tc.function || {};
                if (fn.name && !item.name) item.name = fn.name;
                if (fn.arguments) {
                  item.args += fn.arguments;
                  await send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: item.outputIndex, delta: fn.arguments });
                }
              }
            }


            if (delta.content) {
              if (!contentItem) contentItem = startContent();
              if (!contentItem.started) {
                contentItem.started = true;
                await send({ type: "response.output_item.added", output_index: contentItem.outputIndex, item: { id: contentItem.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
                await send({ type: "response.content_part.added", item_id: contentItem.id, output_index: contentItem.outputIndex, content_index: contentItem.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
              }
              contentItem.text += delta.content;
              await send({ type: "response.output_text.delta", item_id: contentItem.id, output_index: contentItem.outputIndex, content_index: contentItem.contentIndex, delta: delta.content });
            }
          } catch {}
        }
      }


      if (items.length === 0) {
        const item = startContent();
        item.started = true;
        await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
        await send({ type: "response.content_part.added", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
      }


      for (const item of items) {
        if (item.kind === "message") {
          if (!item.started) {
            await send({ type: "response.output_item.added", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
            await send({ type: "response.content_part.added", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part: { type: "output_text", text: "", annotations: [] } });
          }
          const part = { type: "output_text", text: item.text, annotations: [] };
          await send({ type: "response.output_text.done", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, text: item.text });
          await send({ type: "response.content_part.done", item_id: item.id, output_index: item.outputIndex, content_index: item.contentIndex, part });
          await send({ type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "message", status: "completed", role: "assistant", content: [part] } });
        } else {
          await send({ type: "response.output_item.done", output_index: item.outputIndex, item: { id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args } });
        }
      }

      const resp = responsesBase(mc, respId, createdAt);
      resp.status = "completed";
      resp.model = model || mc.id;
      resp.output = items.map((item) =>
        item.kind === "message"
          ? { id: item.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: item.text, annotations: [] }] }
          : { id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args }
      );
      resp.usage = chatUsageToResponsesUsage(usage);
      await send({ type: "response.completed", response: resp });
    } catch {}
    finally {
      try { if (onComplete) await onComplete(); } catch {}
      try { await writer.close(); } catch {}
    }
  })();
}


async function responsesToNonStream(upstreamBody, mc) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  let buf = "", model = "", outputText = "", reasoning = "", usage = null;
  const toolItems = new Map();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      try {
        const obj = unwrapData(JSON.parse(payload));
        const choice = obj?.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.content) outputText += delta.content;
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== "object") continue;
            const ti = tc.index ?? 0;
            let item = toolItems.get(ti);
            if (!item) {
              const fn = tc.function || {};
              item = {
                id: "fc_" + Math.random().toString(36).slice(2, 10),
                callId: tc.id || "call_" + Math.random().toString(36).slice(2, 10),
                name: fn.name || "",
                args: "",
              };
              toolItems.set(ti, item);
            }
            const fn = tc.function || {};
            if (fn.name && !item.name) item.name = fn.name;
            if (fn.arguments) item.args += fn.arguments;
          }
        }
        if (obj.model) model = obj.model;
        if (obj.usage) usage = obj.usage;
      } catch {}
    }
  }
  const resp = responsesBase(mc, undefined, Math.floor(Date.now() / 1000));
  resp.status = "completed";
  resp.model = model || mc.id;
  resp.output = [];
  if (outputText || reasoning) {
    const text = outputText || reasoning;
    resp.output.push({
      id: "msg_" + Math.random().toString(36).slice(2, 10),
      type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const item of toolItems.values()) {
    resp.output.push({ id: item.id, type: "function_call", status: "completed", call_id: item.callId, name: item.name, arguments: item.args });
  }
  resp.usage = chatUsageToResponsesUsage(usage);
  return resp;
}


// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------


function cleanCache() {
  const now = Date.now();
  try {
    if (sessCache.size > 50) {
      for (const [k, v] of sessCache) {
        const exp = v.expiresAt ? new Date(v.expiresAt).getTime() : 0;
        if (exp > 0 && exp < now) sessCache.delete(k);
      }
    }
    if (runCache.size > 50) {
      for (const [k, v] of runCache) {
        if (now - v.ts > RUN_CACHE_TTL_MS) runCache.delete(k);
      }
    }
  } catch {}
}





async function handleModels() {
  let modelList = MODELS;
  try {
    const dyn = await refreshDynamicModelsIfStale();
    if (dyn && dyn.models && dyn.models.length) {
      modelList = mergeModelTables(MODELS, dyn.models);
    }
  } catch {}

  modelList = modelList.filter((m) => !isPausedModel(m.id));
  return jsonResponse({
    object: "list",
    data: modelList.map((m) => ({ id: m.id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "freebuff" })),
  }, 200, { "X-Freebuff2api-Version": VERSION });
}

function getApiKey(request, env) {
  const expected = (env.API_KEY || env.FREEBUFF_API_KEY || DEFAULT_API_KEY).trim();
  if (!expected) return null;
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === expected ? expected : null;
  return request.headers.get("x-api-key") === expected ? expected : null;
}

function jsonResponse(obj, status, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...corsHeaders(), ...extraHeaders } });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-freebuff-instance-id, anthropic-version, anthropic-beta",
  };
}