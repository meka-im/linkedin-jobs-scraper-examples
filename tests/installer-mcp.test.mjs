import assert from 'node:assert/strict';
import test from 'node:test';

import {
  McpClient,
  parseMcpResponse,
} from '../installer/lib/mcp-client.js';
import { createDirectMcpTransport } from '../installer/lib/http-transport.js';

function json(body, id) {
  return JSON.stringify({ jsonrpc: '2.0', id, ...body });
}

test('MCP response parser accepts JSON and matching SSE events', () => {
  const response = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: JSON.stringify({ jsonrpc: '2.0', id: 4, result: { ok: true } }),
  };
  assert.deepEqual(parseMcpResponse(response, 4).result, { ok: true });

  const sse = {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    text: [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notification","params":{}}',
      '',
      'data: {"jsonrpc":"2.0","id":9,"result":{"tools":[]}}',
      '',
    ].join('\n'),
  };
  assert.deepEqual(parseMcpResponse(sse, 9).result, { tools: [] });
});

test('MCP client falls back to legacy initialize and paginates tools/list', async () => {
  const calls = [];
  const transport = {
    async post(message, metadata) {
      calls.push({ message, metadata });
      if (message.method === 'server/discover') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          text: json({
            error: { code: -32601, message: 'Method not found' },
          }, message.id),
        };
      }
      if (message.method === 'initialize') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          text: json({ result: { protocolVersion: '2025-06-18' } }, message.id),
        };
      }
      if (message.method === 'notifications/initialized') {
        return { status: 202, headers: {}, text: '' };
      }
      if (message.method === 'tools/list' && !message.params.cursor) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          text: json({
            result: {
              tools: [{ name: 'validate_workflow' }],
              nextCursor: 'page-2',
            },
          }, message.id),
        };
      }
      if (message.method === 'tools/list') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          text: json({
            result: {
              tools: [{ name: 'create_workflow_from_code' }],
            },
          }, message.id),
        };
      }
      if (message.method === 'tools/call') {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          text: json({
            result: {
              structuredContent: { valid: true },
            },
          }, message.id),
        };
      }
      throw new Error(`Unexpected method ${message.method}`);
    },
  };

  const client = new McpClient(transport);
  await client.connect();
  const tools = await client.listTools();
  assert.equal(client.protocolVersion, '2025-06-18');
  assert.deepEqual(tools.map((tool) => tool.name), [
    'validate_workflow',
    'create_workflow_from_code',
  ]);
  assert.deepEqual(
    await client.callTool('validate_workflow', { code: 'trusted' }),
    { valid: true },
  );
  assert.equal(
    calls.filter(({ message }) => message.method === 'server/discover').length,
    1,
  );
});

test('tool text responses are parsed and tool errors are surfaced without raw responses', async () => {
  const privateSentinel = 'credential=do-not-display@example.invalid';
  const transport = {
    async post(message) {
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        text: message.method === 'tools/call'
          ? json({
            result: {
              content: [{ type: 'text', text: '{"ok":true}' }],
            },
          }, message.id)
          : json({ result: {} }, message.id),
      };
    },
  };
  const client = new McpClient(transport);
  client.protocolVersion = '2025-06-18';
  assert.deepEqual(await client.callTool('get_workflow_details', {}), { ok: true });

  client.transport.post = async (message) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: json({
      result: {
        isError: true,
        content: [{ type: 'text', text: privateSentinel }],
      },
    }, message.id),
  });
  await assert.rejects(
    client.callTool('validate_workflow', {}),
    (error) => error.code === 'MCP_TOOL_ERROR' && !error.message.includes(privateSentinel),
  );

  client.transport.post = async (message) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    text: json({
      error: { code: -32603, message: privateSentinel },
    }, message.id),
  });
  await assert.rejects(
    client.callTool('get_workflow_details', {}),
    (error) => error.code === 'MCP_RPC_ERROR' && !error.message.includes(privateSentinel),
  );
});

test('direct MCP transport sends the bearer token only in the authorization header', async () => {
  let request;
  const transport = createDirectMcpTransport({
    workspace: 'https://meka-test.app.n8n.cloud',
    accessToken: 'secret-token-value',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  await transport.post(
    { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} },
    { protocolVersion: '2026-07-28', methodName: 'server/discover' },
  );
  assert.equal(request.url, 'https://meka-test.app.n8n.cloud/mcp-server/http');
  assert.equal(request.options.headers.Authorization, 'Bearer secret-token-value');
  assert.equal(request.url.includes('secret-token-value'), false);
  assert.equal(JSON.stringify(request.options.body).includes('secret-token-value'), false);
  assert.equal(request.options.redirect, 'error');
});
