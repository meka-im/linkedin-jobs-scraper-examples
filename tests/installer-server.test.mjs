import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createInstallerServer } from '../installer/server.mjs';

async function listenOrSkip(t, server) {
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('The current sandbox forbids loopback listen calls.');
      return null;
    }
    throw error;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address();
}

async function rawRequest(port, {
  method = 'GET',
  path = '/',
  headers = {},
  body = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      method,
      path,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

test('loopback server binds only to 127.0.0.1 and exposes relay health', async (t) => {
  const server = createInstallerServer();
  const address = await listenOrSkip(t, server);
  if (!address) return;
  assert.equal(typeof address, 'object');
  assert.equal(address.address, '127.0.0.1');
  assert.ok(address.port > 0);

  const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    relay: true,
    loopbackOnly: true,
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('server serves the installer shell without external assets', async (t) => {
  const server = createInstallerServer();
  const address = await listenOrSkip(t, server);
  if (!address) return;
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/u);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  const html = await response.text();
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /MEKA n8n Cloud installer/u);
  assert.doesNotMatch(html, /<script[^>]+https?:/iu);
});

test('server serves only the exact shared brand banner from outside the installer root', async (t) => {
  const server = createInstallerServer();
  const address = await listenOrSkip(t, server);
  if (!address) return;

  const banner = await fetch(`http://127.0.0.1:${address.port}/assets/banner.svg`);
  assert.equal(banner.status, 200);
  assert.match(banner.headers.get('content-type'), /^image\/svg\+xml/u);
  assert.match(await banner.text(), /<svg/u);
});

test('server rejects non-loopback hosts and mismatched origins', async (t) => {
  const server = createInstallerServer();
  const address = await listenOrSkip(t, server);
  if (!address) return;
  const origin = `http://127.0.0.1:${address.port}`;

  const foreignHost = await rawRequest(address.port, {
    path: '/api/health',
    headers: { Host: `attacker.example:${address.port}` },
  });
  assert.equal(foreignHost.status, 403);

  const wrongPort = await rawRequest(address.port, {
    path: '/api/health',
    headers: { Host: '127.0.0.1:1' },
  });
  assert.equal(wrongPort.status, 403);

  const wrongOrigin = await rawRequest(address.port, {
    path: '/',
    headers: { Host: `127.0.0.1:${address.port}`, Origin: 'https://attacker.example' },
  });
  assert.equal(wrongOrigin.status, 403);

  const missingRelayOrigin = await rawRequest(address.port, {
    method: 'POST',
    path: '/api/mcp',
    headers: {
      Host: `127.0.0.1:${address.port}`,
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      'X-MEKA-Target-Origin': 'https://meka-test.app.n8n.cloud',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(missingRelayOrigin.status, 403);

  const valid = await fetch(`${origin}/api/health`);
  assert.equal(valid.status, 200);
});

test('relay cancels a streamed upstream response as soon as it exceeds five megabytes', async (t) => {
  let cancelled = false;
  let upstreamContentLength = 'not-read';
  const upstreamBody = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const server = createInstallerServer({
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    fetchImpl: async () => {
      const response = new Response(upstreamBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      upstreamContentLength = response.headers.get('content-length');
      return response;
    },
  });
  const address = await listenOrSkip(t, server);
  if (!address) return;
  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/api/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
      Origin: origin,
      'X-MEKA-Target-Origin': 'https://meka-test.app.n8n.cloud',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(response.status, 502);
  assert.equal(upstreamContentLength, null);
  assert.equal(cancelled, true);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});
