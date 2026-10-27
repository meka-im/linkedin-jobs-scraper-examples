import { InstallerError } from '../lib/errors.js';
import {
  validateMcpRpcBody,
  validateRelayRoutingHeaders,
  validateRelayTarget,
} from '../lib/relay-request-policy.js';
import { sanitizeMcpResponseBody } from '../lib/relay-response-policy.js';
import { SECURITY_HEADERS } from '../lib/security-headers.js';

const MAX_REQUEST_BYTES = 320_000;
const MAX_UPSTREAM_BYTES = 5_000_000;
const TIMEOUT_MS = 45_000;
const UPSTREAM_TOO_LARGE = Symbol('UPSTREAM_TOO_LARGE');
const REQUEST_TOO_LARGE = Symbol('REQUEST_TOO_LARGE');

function commonHeaders(origin = null) {
  const headers = new Headers(SECURITY_HEADERS);
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function jsonResponse(status, body, origin = null) {
  const headers = commonHeaders(origin);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function requestOrigin(request) {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  if (
    url.protocol !== 'https:'
    || !host
    || host.length > 255
    || host.toLowerCase() !== url.host.toLowerCase()
  ) {
    return null;
  }
  return url.origin;
}

function bearerToken(headers) {
  const authorization = headers.get('authorization');
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  return token && token.length <= 16_384 ? token : null;
}

async function cancelBody(body) {
  try {
    await body?.cancel();
  } catch {
    // The body may already be closed or locked.
  }
}

async function readLimitedBody(body, limit, tooLarge) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be closed.
        }
        throw tooLarge;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader may already have released its lock.
    }
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function readLimitedUpstream(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) {
    await cancelBody(response.body);
    throw UPSTREAM_TOO_LARGE;
  }
  return readLimitedBody(response.body, MAX_UPSTREAM_BYTES, UPSTREAM_TOO_LARGE);
}

function preflightHeaders(origin) {
  const headers = commonHeaders(origin);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, X-MEKA-Target-Origin',
  );
  headers.set('Access-Control-Max-Age', '600');
  return headers;
}

async function rateLimitFailure(request, env, origin) {
  const limiter = env?.MCP_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') {
    return jsonResponse(503, { error: 'The installer relay rate limiter is not configured.' }, origin);
  }
  const clientIp = request.headers.get('cf-connecting-ip')?.trim();
  if (!clientIp || clientIp.length > 64) {
    return jsonResponse(503, { error: 'The installer relay could not identify the client safely.' }, origin);
  }

  let result;
  try {
    result = await limiter.limit({ key: `meka-n8n-installer:${clientIp}` });
  } catch {
    return jsonResponse(503, { error: 'The installer relay rate limiter is unavailable.' }, origin);
  }
  if (result?.success === true) return null;

  const response = jsonResponse(429, { error: 'Too many installer requests. Try again shortly.' }, origin);
  response.headers.set('Retry-After', '60');
  return response;
}

function withStaticHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  const nullBody = response.status === 204 || response.status === 205 || response.status === 304;
  return new Response(nullBody ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function relayMcp(request, origin, { fetchImpl, env }) {
  if (request.headers.get('origin') !== origin) {
    return jsonResponse(403, { error: 'The request Origin does not match this installer.' }, origin);
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: preflightHeaders(origin) });
  }
  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Use POST for the MCP relay.' }, origin);
  }
  const rateLimited = await rateLimitFailure(request, env, origin);
  if (rateLimited) return rateLimited;
  const token = bearerToken(request.headers);
  if (!token) {
    return jsonResponse(401, { error: 'A Bearer token is required.' }, origin);
  }
  if (!String(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return jsonResponse(415, { error: 'Use application/json.' }, origin);
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse(413, { error: 'The MCP request is too large.' }, origin);
  }

  let workspace;
  let bodyBytes;
  let rpc;
  try {
    workspace = validateRelayTarget(request.headers.get('x-meka-target-origin'));
    bodyBytes = await readLimitedBody(request.body, MAX_REQUEST_BYTES, REQUEST_TOO_LARGE);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
    const body = JSON.parse(text);
    rpc = validateMcpRpcBody(body);
    validateRelayRoutingHeaders(request.headers, rpc);
  } catch (error) {
    if (error === REQUEST_TOO_LARGE) {
      return jsonResponse(413, { error: 'The MCP request is too large.' }, origin);
    }
    if (error instanceof InstallerError) {
      return jsonResponse(400, { error: 'The MCP relay request is not allowed.' }, origin);
    }
    return jsonResponse(400, { error: 'The MCP relay request is invalid.' }, origin);
  }

  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });
  for (const name of ['mcp-protocol-version', 'mcp-method', 'mcp-name']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  let upstream;
  try {
    upstream = await fetchImpl(workspace.mcpUrl, {
      method: 'POST',
      headers,
      body: bodyBytes,
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return jsonResponse(502, { error: 'The n8n MCP server could not be reached.' }, origin);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await cancelBody(upstream.body);
    return jsonResponse(502, { error: 'The n8n MCP server returned a redirect.' }, origin);
  }

  if (rpc.method === 'notifications/initialized' && upstream.status >= 200 && upstream.status < 300) {
    await cancelBody(upstream.body);
    return new Response(null, {
      status: upstream.status,
      headers: commonHeaders(origin),
    });
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (
    !contentType.toLowerCase().startsWith('application/json')
    && !contentType.toLowerCase().startsWith('text/event-stream')
  ) {
    await cancelBody(upstream.body);
    return jsonResponse(502, { error: 'The n8n MCP server returned an unsupported response.' }, origin);
  }
  let responseBody;
  try {
    responseBody = await readLimitedUpstream(upstream);
  } catch {
    return jsonResponse(
      502,
      { error: 'The n8n MCP response exceeded the installer limit or could not be read.' },
      origin,
    );
  }
  responseBody = sanitizeMcpResponseBody({
    toolName: rpc.toolName,
    arguments: rpc.toolArguments,
    contentType,
    body: responseBody,
  });

  const headersOut = commonHeaders(origin);
  headersOut.set('Content-Type', contentType);
  return new Response(responseBody, {
    status: upstream.status,
    headers: headersOut,
  });
}

export async function handleRequest(
  request,
  env,
  { fetchImpl = fetch } = {},
) {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') {
    const origin = requestOrigin(request);
    if (!origin) {
      return jsonResponse(403, { error: 'The installer requires its canonical Host.' });
    }
    if (request.method !== 'GET') {
      return jsonResponse(405, { error: 'Use GET for health.' }, origin);
    }
    if (url.search) return jsonResponse(400, { error: 'Health accepts no query string.' }, origin);
    return jsonResponse(200, {
      relay: true,
      publicRelay: true,
      loopbackOnly: false,
    }, origin);
  }

  if (url.pathname === '/api/mcp') {
    const origin = requestOrigin(request);
    if (!origin) {
      return jsonResponse(403, { error: 'The installer requires its canonical Host.' });
    }
    if (url.search) return jsonResponse(400, { error: 'The MCP relay path accepts no query string.' }, origin);
    return relayMcp(request, origin, { fetchImpl, env });
  }

  if (!env?.ASSETS?.fetch) {
    return jsonResponse(404, { error: 'Not found.' });
  }
  return withStaticHeaders(await env.ASSETS.fetch(request));
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
