import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookup as dnsLookup } from 'node:dns/promises';

import {
  isPrivateAddress,
  validateMcpRpcBody,
  validateRelayRoutingHeaders,
  validateRelayTarget,
} from './lib/relay-policy.js';
import { SECURITY_HEADERS } from './lib/security-headers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = here;
const MAX_REQUEST_BYTES = 320_000;
const MAX_UPSTREAM_BYTES = 5_000_000;
const UPSTREAM_TOO_LARGE = Symbol('UPSTREAM_TOO_LARGE');

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function securityHeaders() {
  return { ...SECURITY_HEADERS };
}

function sendJson(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
  });
  response.end(bytes);
}

async function readRequestBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error('request-too-large');
      error.code = 'REQUEST_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length);
  return token && token.length <= 16_384 ? token : null;
}

function requestOrigin(request) {
  const host = request.headers.host;
  const localPort = Number(request.socket.localPort);
  if (
    typeof host !== 'string'
    || !host
    || host.length > 255
    || !Number.isInteger(localPort)
    || localPort < 1
    || localPort > 65535
  ) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  const effectivePort = parsed.port ? Number(parsed.port) : 80;
  if (
    parsed.protocol !== 'http:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || (hostname !== '127.0.0.1' && hostname !== 'localhost')
    || effectivePort !== localPort
  ) {
    return null;
  }
  return parsed.origin;
}

function requestHasValidOrigin(request, allowedOrigin) {
  const origin = request.headers.origin;
  return origin === undefined || origin === allowedOrigin;
}

async function hostIsPublic(hostname, lookupImpl) {
  const addresses = await lookupImpl(hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length === 0) return false;
  return addresses.every(({ address }) => !isPrivateAddress(address));
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response may already be closed or locked.
  }
}

async function readLimitedUpstream(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BYTES) {
    await cancelBody(response);
    throw UPSTREAM_TOO_LARGE;
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPSTREAM_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The upstream stream may already be closed.
        }
        throw UPSTREAM_TOO_LARGE;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader may already have released its lock.
    }
  }
  return Buffer.concat(chunks, total);
}

async function relayMcp(request, response, { fetchImpl, lookupImpl }) {
  const token = bearerToken(request);
  if (!token) {
    sendJson(response, 401, { error: 'A Bearer token is required.' });
    return;
  }
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    sendJson(response, 415, { error: 'Use application/json.' });
    return;
  }

  let workspace;
  let rpc;
  try {
    workspace = validateRelayTarget(request.headers['x-meka-target-origin']);
    const text = await readRequestBody(request);
    const body = JSON.parse(text);
    rpc = validateMcpRpcBody(body);
    validateRelayRoutingHeaders(request.headers, rpc);
    request.mcpBody = body;
  } catch (error) {
    const status = error?.code === 'REQUEST_TOO_LARGE' ? 413 : 400;
    sendJson(response, status, {
      error: status === 413 ? 'The MCP request is too large.' : 'The MCP relay request is invalid.',
    });
    return;
  }

  try {
    if (!(await hostIsPublic(workspace.slug + '.app.n8n.cloud', lookupImpl))) {
      sendJson(response, 400, { error: 'The workspace host did not resolve to a public address.' });
      return;
    }
  } catch {
    sendJson(response, 400, { error: 'The workspace host could not be resolved.' });
    return;
  }

  const forwardedHeaders = {
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  for (const name of ['mcp-protocol-version', 'mcp-method', 'mcp-name']) {
    const value = request.headers[name];
    if (typeof value === 'string' && value.length <= 512) {
      forwardedHeaders[name] = value;
    }
  }

  let upstream;
  try {
    upstream = await fetchImpl(workspace.mcpUrl, {
      method: 'POST',
      headers: forwardedHeaders,
      body: JSON.stringify(request.mcpBody),
      redirect: 'manual',
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    sendJson(response, 502, { error: 'The n8n MCP server could not be reached.' });
    return;
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    sendJson(response, 502, { error: 'The n8n MCP server returned a redirect.' });
    return;
  }

  let body;
  try {
    body = await readLimitedUpstream(upstream);
  } catch {
    sendJson(
      response,
      502,
      { error: 'The n8n MCP response exceeded the installer limit or could not be read.' },
    );
    return;
  }
  response.writeHead(upstream.status, {
    ...securityHeaders(),
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  response.end(body);
}

async function serveStatic(pathname, response) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    sendJson(response, 400, { error: 'Invalid path.' });
    return;
  }
  const isBrandBanner = decoded === '/assets/banner.svg';
  const target = isBrandBanner
    ? path.resolve(STATIC_ROOT, '..', 'assets', 'banner.svg')
    : path.resolve(STATIC_ROOT, `.${decoded}`);
  if (
    !isBrandBanner
    && target !== STATIC_ROOT
    && !target.startsWith(`${STATIC_ROOT}${path.sep}`)
  ) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  if (!info.isFile()) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  response.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': CONTENT_TYPES.get(path.extname(target)) ?? 'application/octet-stream',
    'Content-Length': info.size,
  });
  createReadStream(target).pipe(response);
}

export function createInstallerServer({
  fetchImpl = fetch,
  lookupImpl = dnsLookup,
} = {}) {
  return http.createServer(async (request, response) => {
    const allowedOrigin = requestOrigin(request);
    if (!allowedOrigin) {
      sendJson(response, 403, { error: 'The installer only accepts loopback Host headers.' });
      return;
    }
    if (!requestHasValidOrigin(request, allowedOrigin)) {
      sendJson(response, 403, { error: 'The request Origin does not match this loopback installer.' });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { relay: true, loopbackOnly: true });
      return;
    }
    if (url.pathname === '/api/mcp') {
      if (request.headers.origin !== allowedOrigin) {
        sendJson(response, 403, { error: 'MCP relay requests require the exact loopback Origin.' });
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(405, { ...securityHeaders(), Allow: 'POST' });
        response.end();
        return;
      }
      await relayMcp(request, response, { fetchImpl, lookupImpl });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...securityHeaders(), Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    await serveStatic(url.pathname, response);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const requestedPort = Number(process.env.PORT ?? 4173);
  const port = Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535
    ? requestedPort
    : 4173;
  const server = createInstallerServer();
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`MEKA installer: http://127.0.0.1:${port}/\n`);
  });
}
