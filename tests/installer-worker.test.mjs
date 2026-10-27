import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRequest } from '../installer/worker/index.mjs';
import { McpClient } from '../installer/lib/mcp-client.js';

const RELAY = 'https://meka-installer.example';
const WORKSPACE = 'https://meka-test.app.n8n.cloud';

function relayHeaders(overrides = {}) {
  return {
    Host: 'meka-installer.example',
    Origin: RELAY,
    Authorization: 'Bearer memory-only-token',
    'CF-Connecting-IP': '203.0.113.10',
    'Content-Type': 'application/json',
    'X-MEKA-Target-Origin': WORKSPACE,
    ...overrides,
  };
}

function workerEnv(overrides = {}) {
  return {
    MCP_RATE_LIMITER: {
      async limit() {
        return { success: true };
      },
    },
    ...overrides,
  };
}

function relayRequest(body = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {},
}, {
  method = 'POST',
  headers = relayHeaders(),
  path = '/api/mcp',
} = {}) {
  return new Request(`${RELAY}${path}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : (
      typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)
    ),
  });
}

function jsonRpc(result, status = 200, headers = {}) {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result,
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

test('worker serves health and delegates non-API assets to the static binding', async () => {
  const calls = [];
  const env = workerEnv({
    ASSETS: {
      async fetch(request) {
        calls.push(request);
        return new Response('<!doctype html><title>MEKA</title>', {
          headers: { 'Content-Type': 'text/html' },
        });
      },
    },
  });
  const health = await handleRequest(new Request(`${RELAY}/api/health`, {
    headers: {
      Host: 'meka-installer.example',
      Origin: RELAY,
    },
  }), env);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    relay: true,
    publicRelay: true,
    loopbackOnly: false,
  });
  assert.equal(health.headers.get('access-control-allow-origin'), RELAY);

  const page = await handleRequest(new Request(`${RELAY}/`, {
    headers: { Host: 'meka-installer.example' },
  }), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /MEKA/u);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(calls.length, 1);
});

test('worker rejects spoofed Host, mismatched Origin, and preflight without Origin', async () => {
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    throw new Error('fetch must not run');
  };
  const wrongHost = await handleRequest(relayRequest(undefined, {
    headers: relayHeaders({ Host: 'attacker.example' }),
  }), workerEnv(), { fetchImpl });
  assert.equal(wrongHost.status, 403);

  const wrongOrigin = await handleRequest(relayRequest(undefined, {
    headers: relayHeaders({ Origin: 'https://attacker.example' }),
  }), workerEnv(), { fetchImpl });
  assert.equal(wrongOrigin.status, 403);

  const preflight = await handleRequest(relayRequest(null, {
    method: 'OPTIONS',
    headers: relayHeaders({ Origin: '', Authorization: '', 'Content-Type': '' }),
  }), workerEnv(), { fetchImpl });
  assert.equal(preflight.status, 403);

  const validPreflight = await handleRequest(relayRequest(null, {
    method: 'OPTIONS',
    headers: relayHeaders({ Authorization: '', 'Content-Type': '' }),
  }), workerEnv(), { fetchImpl });
  assert.equal(validPreflight.status, 204);
  assert.equal(validPreflight.headers.get('access-control-allow-origin'), RELAY);
  assert.match(validPreflight.headers.get('access-control-allow-methods'), /POST/u);
  assert.equal(fetched, false);
});

test('worker rejects arbitrary targets, unlisted tools, and spoofed routing headers', async () => {
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return jsonRpc({});
  };
  const cases = [
    relayRequest(undefined, {
      headers: relayHeaders({ 'X-MEKA-Target-Origin': 'https://attacker.example' }),
    }),
    relayRequest(undefined, {
      headers: relayHeaders({ 'X-MEKA-Target-Origin': `${WORKSPACE}/not-the-mcp-path` }),
    }),
    relayRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'execute_workflow', arguments: {} },
    }),
    relayRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_credentials', arguments: {} },
    }, {
      headers: relayHeaders({
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'execute_workflow',
      }),
    }),
    relayRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'publish_workflow',
      params: {},
    }),
  ];

  for (const request of cases) {
    const response = await handleRequest(request, workerEnv(), { fetchImpl });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /memory-only-token/u);
  }
  assert.equal(fetched, 0);
});

test('worker forwards only the reviewed MCP envelope to the fixed workspace path', async () => {
  let upstream;
  const upstreamResponse = jsonRpc({ data: [] }, 200, {
    'Set-Cookie': 'must-not-forward=true',
    'X-Private-Upstream': 'must-not-forward',
  });
  const body = {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'list_credentials',
      arguments: { type: 'apifyOAuth2Api', limit: 200 },
    },
  };
  const request = relayRequest(body, {
    headers: relayHeaders({
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'list_credentials',
      'MCP-Protocol-Version': '2026-07-28',
      Cookie: 'user-cookie=must-not-forward',
    }),
  });
  const response = await handleRequest(request, workerEnv(), {
    async fetchImpl(url, options) {
      upstream = { url, options };
      return upstreamResponse;
    },
  });
  assert.equal(response.status, 200);
  assert.equal(upstream.url, `${WORKSPACE}/mcp-server/http`);
  assert.equal(upstream.options.method, 'POST');
  assert.equal(upstream.options.redirect, 'manual');
  assert.equal(upstream.options.credentials, 'omit');
  assert.equal(upstream.options.headers.get('authorization'), 'Bearer memory-only-token');
  assert.equal(upstream.options.headers.get('mcp-name'), 'list_credentials');
  assert.equal(upstream.options.headers.get('cookie'), null);
  assert.equal(upstream.options.headers.get('x-meka-target-origin'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), RELAY);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-private-upstream'), null);
  assert.equal(upstream.options.signal instanceof AbortSignal, true);
});

test('worker blocks redirects and unbounded upstream bodies and cancels the stream', async () => {
  const redirect = await handleRequest(relayRequest(), workerEnv(), {
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { Location: `${WORKSPACE}/other` },
    }),
  });
  assert.equal(redirect.status, 502);

  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const oversized = await handleRequest(relayRequest(), workerEnv(), {
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  assert.equal(oversized.status, 502);
  assert.equal(cancelled, true);
});

test('worker rejects an oversized request before forwarding it', async () => {
  let fetched = false;
  const request = relayRequest(new Uint8Array(320_001));
  const response = await handleRequest(request, workerEnv(), {
    fetchImpl: async () => {
      fetched = true;
      return jsonRpc({});
    },
  });
  assert.equal(response.status, 413);
  assert.equal(fetched, false);
});

test('worker fails closed when the rate-limit binding is missing or refuses a request', async () => {
  let fetched = false;
  const missingBinding = await handleRequest(relayRequest(), {}, {
    fetchImpl: async () => {
      fetched = true;
      return jsonRpc({});
    },
  });
  assert.equal(missingBinding.status, 503);

  let rateLimitKey;
  const limited = await handleRequest(relayRequest(), workerEnv({
    MCP_RATE_LIMITER: {
      async limit({ key }) {
        rateLimitKey = key;
        return { success: false };
      },
    },
  }), {
    fetchImpl: async () => {
      fetched = true;
      return jsonRpc({});
    },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(rateLimitKey, 'meka-n8n-installer:203.0.113.10');
  assert.equal(fetched, false);
  assert.doesNotMatch(await limited.text(), /memory-only-token/u);
});

for (const notificationStatus of [202, 204]) {
  test(`worker completes the legacy MCP handshake with a ${notificationStatus} initialized response`, async () => {
    const upstreamMethods = [];
    const workerEnvironment = workerEnv();
    const transport = {
      async post(message, metadata = {}) {
        const headers = relayHeaders();
        if (metadata.methodName) headers['Mcp-Method'] = metadata.methodName;
        if (metadata.toolName) headers['Mcp-Name'] = metadata.toolName;
        const workerResponse = await handleRequest(
          relayRequest(message, { headers }),
          workerEnvironment,
          {
            async fetchImpl(url, options) {
              assert.equal(url, `${WORKSPACE}/mcp-server/http`);
              const upstreamMessage = JSON.parse(new TextDecoder().decode(options.body));
              upstreamMethods.push(upstreamMessage.method);
              if (upstreamMessage.method === 'server/discover') {
                return new Response(JSON.stringify({
                  jsonrpc: '2.0',
                  id: upstreamMessage.id,
                  error: { code: -32601, message: 'Method not found' },
                }), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                });
              }
              if (upstreamMessage.method === 'initialize') {
                return new Response(JSON.stringify({
                  jsonrpc: '2.0',
                  id: upstreamMessage.id,
                  result: { protocolVersion: '2025-06-18' },
                }), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                });
              }
              if (upstreamMessage.method === 'notifications/initialized') {
                return new Response(null, { status: notificationStatus });
              }
              if (upstreamMessage.method === 'tools/list') {
                return new Response(JSON.stringify({
                  jsonrpc: '2.0',
                  id: upstreamMessage.id,
                  result: { tools: [] },
                }), {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                });
              }
              throw new Error(`Unexpected method ${upstreamMessage.method}`);
            },
          },
        );
        return {
          status: workerResponse.status,
          headers: workerResponse.headers,
          text: await workerResponse.text(),
          url: `${WORKSPACE}/mcp-server/http`,
        };
      },
    };

    const client = new McpClient(transport);
    await client.connect();
    await client.listTools();
    assert.equal(client.protocolVersion, '2025-06-18');
    assert.deepEqual(upstreamMethods, [
      'server/discover',
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });
}
