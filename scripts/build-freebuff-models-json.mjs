#!/usr/bin/env node



//

// {

//   "source": "CodebuffAI/freebuff main",

//   "pools": { "premium": [...], "glm": [...], "standard": [...] }
// }
//



import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");


const SOURCES = {
  agents: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/free-agents.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/free-agents.ts",
  ],
  models: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-models.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-models.ts",
  ],
  stableIds: [
    "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants/freebuff-model-ids.ts",
    "https://cdn.jsdelivr.net/gh/CodebuffAI/freebuff@main/common/src/constants/freebuff-model-ids.ts",
  ],
};



function parseModelIdConstants(source) {
  const table = {};
  const knownDefaults = { mimoV25: "mimo/mimo-v2.5" };
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
    lineRe.lastIndex = 0;
    let m;
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
    while ((im = itemRe.exec(pm[3])) !== null) {
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




function parsePausedModels(source, modelIdConstants) {
  const paused = new Set();


  const listRe = /export\s+const\s+FREEBUFF_PAUSED_FREE_MODEL_IDS\s*:?[^=]*=\s*\[([^\]]*)\]/;
  const listMatch = listRe.exec(source);
  if (!listMatch) return paused;
  for (const line of listMatch[1].split("\n")) {
    const m = /'([^']*)'|"([^"]*)"/.exec(line);
    if (!m) continue;
    const lit = m[1] ?? m[2];
    if (lit && lit.includes("/")) paused.add(lit);
  }
  return paused;
}



async function fetchFirst(urls) {
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.length > 100) return text;
      }
    } catch {}
  }
  return null;
}



async function main() {
  const outPath = process.argv[2] || join(REPO_ROOT, "freebuff-models.json");
  const [agentsSrc, modelsSrc, stableIdsSrc] = await Promise.all([
    fetchFirst(SOURCES.agents),
    fetchFirst(SOURCES.models),
    fetchFirst(SOURCES.stableIds),
  ]);
  if (!agentsSrc || !modelsSrc) {
    console.error("❌ Failed to fetch the official source (agents or models are empty); JSON will not be generated");
    process.exit(1);
  }
  try {
    const modelIdConstants = {
      ...parseModelIdConstants(stableIdsSrc || ""),
      ...parseModelIdConstants(modelsSrc),
    };
    const agentMappings = parseAgentMappings(agentsSrc, modelIdConstants);
    if (Object.keys(agentMappings.root).length === 0) {
      console.error("❌ Parsed agent mapping is empty; JSON will not be generated");
      process.exit(1);
    }
    const pools = parseModelPools(modelsSrc, modelIdConstants);

    const premiumIds = pools.premium.length > 0
      ? pools.premium
      : parseCatalogPremiumFlags(modelsSrc, modelIdConstants).premium;
    const paused = parsePausedModels(modelsSrc, modelIdConstants);
    if (paused.size > 0) {
      console.log(`ℹ️  Upstream paused models (removed from snapshot): ${[...paused].join(", ")}`);
    }
    const models = Object.entries(agentMappings.root)
      .map(([modelId, rootAgent]) => ({
        id: modelId,
        session: modelId,
        agent: rootAgent,
        root_agent: rootAgent,
        base3_agent: agentMappings.base3[modelId] || null,
        reviewer_agent: agentMappings.reviewer[modelId] || null,
        upstream: modelId,
      }))
      .filter((m) => !paused.has(m.id));
    const premium = new Set(premiumIds);
    for (const id of paused) premium.delete(id);
    const glm = new Set(pools.glm);
    const standard = models
      .map((m) => m.id)
      .filter((id) => !premium.has(id) && !glm.has(id));
    const payload = {
      generatedAt: new Date().toISOString(),
      source: "CodebuffAI/freebuff main",
      models,
      pools: {
        premium: [...premium],
        glm: [...glm],
        standard,
      },
    };
    writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
    console.log(`✅ Generated ${outPath}`);
    console.log(`   Model count: ${models.length}`);


    const mdPath = join(REPO_ROOT, "MODELS.md");
    const beijingTime = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }).replace(" ", " ");
    const knownNames = {
      "deepseek/deepseek-v4-flash":   "DeepSeek V4 Flash (strong reasoning, coding and mathematics)",
      "deepseek/deepseek-v4-pro":     "DeepSeek V4 Pro (high-end reasoning model)",
      "minimax/minimax-m3":           "MiniMax M3 (strong general-purpose model)",
      "mimo/mimo-v2.5":               "MiMo V2.5 (lightweight and efficient for fast tasks)",
      "openai/gpt-5.6-luna":          "GPT-5.6 Luna (OpenAI model with strong reasoning)",
      "z-ai/glm-5.2":                 "GLM 5.2 (Zhipu AI model)",
      "poolside/laguna-s-2.1":        "Laguna S 2.1 (Poolside coding model)",
      "openrouter/poolside/laguna-s-2.1": "Laguna S 2.1 (OpenRouter route)",
      "inclusionai/ling-3.0-flash:free": "Ling 3.0 Flash (free model, fast responses)",
      "crof/greg-2-ultra":            "Greg 2 Ultra (CROF flagship model)",
      "crof/greg-2-super":            "Greg 2 Super (CROF high-performance model)",
      "anthropic/claude-fable-5":     "Claude Fable 5 (limited Anthropic model)",
      "meta/muse-spark-1.2-contributor": "Muse Spark 1.2 (limited Meta contributor model)",
      "crof/kimi-k3-eco":            "Kimi K3 Eco (balanced CROF model)",
    };
    const mdLines = [
      `## Available Freebuff Models (${beijingTime} Beijing Time)`,
      "",
      `> Automatically generated · Source: [CodebuffAI/freebuff](https://github.com/CodebuffAI/freebuff) main · Refresh interval: every 6 hours`,
      "",
    ];

    const sections = [
      { title: "Premium Models", ids: [...premium].sort() },
      { title: "Standard Models", ids: standard.sort() },
      { title: "Independent Pool (GLM)", ids: [...glm].sort() },
    ];
    for (const sec of sections) {
      mdLines.push(`## ${sec.title}`, "");
      for (const id of sec.ids) {
        const desc = knownNames[id] || id;
        mdLines.push(`- \`${id}\` —— ${desc}`);
      }
      mdLines.push("");
    }
    mdLines.push(`---`, `${models.length} models total · Last updated: ${beijingTime}`, "");
    writeFileSync(mdPath, mdLines.join("\n"));
    console.log(`✅ Generated ${mdPath}`);
  } catch (e) {
    console.error("❌ Parsing failed:", e.message);
    process.exit(1);
  }
}

main();
