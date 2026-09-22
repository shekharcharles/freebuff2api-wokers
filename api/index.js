

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));


const worker = await import(resolve(__dirname, '../worker.js'));

const workerModule = worker.default;


export const config = {
  api: {
    bodyParser: false,
  },
};


function buildEnv(processEnv = process.env) {
  const env = {
    FREEBUFF_TOKEN: processEnv.FREEBUFF_TOKEN || '',
    FREEBUFF_API_KEY: processEnv.FREEBUFF_API_KEY || 'freebuff-default-key',
    FREEBUFF_DEBUG: processEnv.FREEBUFF_DEBUG || 'false',
    CODEBUFF_API: processEnv.CODEBUFF_API || '',
    RELAY_KEY: processEnv.RELAY_KEY || '',
  };
  return env;
}


function isWebRequest(request) {
  return typeof request?.headers?.get === 'function' && typeof request?.arrayBuffer === 'function';
}

// Node req → Fetch Request
async function nodeRequestToFetchRequest(request) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }

  const forwardedProto = request.headers?.['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : String(forwardedProto || 'https').split(',')[0].trim();
  const host = request.headers?.host || 'localhost';
  const url = new URL(request.url || '/', `${proto || 'https'}://${host}`);

  const method = request.method || 'GET';
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await readNodeRequestBody(request);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function readNodeRequestBody(request) {
  if (request.body !== undefined && request.body !== null) {
    if (typeof request.body === 'string' || Buffer.isBuffer(request.body) || request.body instanceof Uint8Array) {
      return request.body;
    }
    return JSON.stringify(request.body);
  }
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}


async function sendNodeResponse(response, fetchResponse) {
  response.statusCode = fetchResponse.status;
  response.statusMessage = fetchResponse.statusText;
  fetchResponse.headers.forEach((value, key) => {

    if (['content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) return;
    response.setHeader(key, value);
  });

  if (!fetchResponse.body) {
    response.end();
    return;
  }

  const reader = fetchResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) {
        await new Promise((resolve) => response.once('drain', resolve));
      }
    }
  } finally {
    response.end();
    reader.releaseLock();
  }
}

export default async function handler(request, response) {
  try {
    const fetchRequest = isWebRequest(request)
      ? request
      : await nodeRequestToFetchRequest(request);
    const env = buildEnv();
    const fetchResponse = await workerModule.fetch(fetchRequest, env);

    if (!response) return fetchResponse;
    return sendNodeResponse(response, fetchResponse);
  } catch (err) {
    console.error('[vercel] error:', err?.stack || err?.message || err);
    if (!response.headersSent) {
      response.statusCode = 502;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: { message: 'proxy error', type: 'proxy_error' } }));
    } else if (!response.writableEnded) {
      response.end();
    }
  }
}
