import assert from 'node:assert/strict';
import test from 'node:test';

import { createMemorySessionStore } from '../installer/lib/oauth-session.js';
import {
  OAUTH_TTL_MS,
  beginOAuthConnection,
  discoverOAuth,
  finishOAuthConnection,
  normalizeRedirectUri,
} from '../installer/lib/oauth.js';
import { createPkcePair } from '../installer/lib/pkce.js';
import {
  isPrivateAddress,
  validateMcpRpcBody,
  validateRelayTarget,
} from '../installer/lib/relay-policy.js';
import { RELAY_ALLOWED_NODE_SETS } from '../installer/lib/relay-request-policy.js';
import { sanitizeMcpResponseBody } from '../installer/lib/relay-response-policy.js';
import {
  assertSameOriginUrl,
  parseWorkspaceUrl,
} from '../installer/lib/workspace.js';
import { InstallerError } from '../installer/lib/errors.js';

const ORIGIN = 'https://meka-test.app.n8n.cloud';
const REDIRECT = 'https://installer.example/meka/';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function oauthBodies(overrides = {}) {
  return {
    protected: {
      resource: `${ORIGIN}/mcp-server/http`,
      authorization_servers: [ORIGIN],
      scopes_supported: [
        'workflow:read',
        'workflow:write',
        'credential:read',
        'workflow:execute',
        'execution:read',
      ],
      ...overrides.protected,
    },
    metadata: {
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/mcp-oauth/authorize`,
      token_endpoint: `${ORIGIN}/mcp-oauth/token`,
      registration_endpoint: `${ORIGIN}/mcp-oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      ...overrides.metadata,
    },
    registration: {
      client_id: 'public-client-id',
      token_endpoint_auth_method: 'none',
      ...overrides.registration,
    },
    token: {
      access_token: 'memory-only-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: [
        'workflow:read',
        'workflow:write',
        'credential:read',
        'workflow:execute',
        'execution:read',
      ].join(' '),
      ...overrides.token,
    },
  };
}

function oauthFetch(overrides = {}) {
  const bodies = oauthBodies(overrides);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const text = String(url);
    calls.push({ url: text, method: options.method ?? 'GET', options });
    if (text.endsWith('/.well-known/oauth-protected-resource/mcp-server/http')) {
      return jsonResponse(bodies.protected);
    }
    if (text.endsWith('/.well-known/oauth-authorization-server')) {
      return jsonResponse(bodies.metadata);
    }
    if (text.endsWith('/mcp-oauth/register')) {
      return jsonResponse(bodies.registration, 201);
    }
    if (text.endsWith('/mcp-oauth/token')) {
      return jsonResponse(bodies.token);
    }
    return jsonResponse({ error: 'not found' }, 404);
  };
  return { fetchImpl, calls, bodies };
}

test('workspace parsing accepts only canonical n8n Cloud workspace origins', () => {
  const workspace = parseWorkspaceUrl('https://meka-test.app.n8n.cloud');
  assert.equal(workspace.origin, ORIGIN);
  assert.equal(workspace.mcpUrl, `${ORIGIN}/mcp-server/http`);
  assert.equal(workspace.settingsMcpUrl, `${ORIGIN}/settings/mcp`);

  const invalid = [
    'http://meka-test.app.n8n.cloud',
    'https://meka-test.app.n8n.cloud/path',
    'https://meka-test.app.n8n.cloud?x=1',
    'https://meka-test.app.n8n.cloud#x',
    'https://user@meka-test.app.n8n.cloud',
    'https://meka-test.app.n8n.cloud:443',
    'https://127.0.0.1.app.n8n.cloud',
    'https://meka.app.n8n.cloud.evil.example',
    '',
  ];
  for (const value of invalid) {
    assert.throws(() => parseWorkspaceUrl(value), InstallerError, value);
  }
  assert.throws(() => assertSameOriginUrl('https://evil.example/token', ORIGIN), {
    code: 'OAUTH_ORIGIN_MISMATCH',
  });
});

test('PKCE uses a high-entropy verifier and an S256 challenge', async () => {
  const first = await createPkcePair();
  const second = await createPkcePair();
  assert.match(first.verifier, /^[A-Za-z0-9_-]{86}$/u);
  assert.notEqual(first.verifier, second.verifier);
  assert.equal(first.method, 'S256');
  assert.match(first.challenge, /^[A-Za-z0-9_-]{43}$/u);
});

test('OAuth discovery rejects cross-origin token and issuer metadata', async () => {
  const crossToken = oauthFetch({
    metadata: { token_endpoint: 'https://attacker.example/token' },
  });
  await assert.rejects(
    discoverOAuth({ workspace: ORIGIN, fetchImpl: crossToken.fetchImpl }),
    { code: 'OAUTH_ORIGIN_MISMATCH' },
  );

  const crossIssuer = oauthFetch({
    metadata: { issuer: 'https://attacker.example' },
  });
  await assert.rejects(
    discoverOAuth({ workspace: ORIGIN, fetchImpl: crossIssuer.fetchImpl }),
    { code: 'OAUTH_ISSUER_MISMATCH' },
  );
});

test('OAuth authorization completes once and removes verifier and state from storage', async () => {
  const { fetchImpl } = oauthFetch();
  const storage = createMemorySessionStore();
  const now = 1_800_000_000_000;
  const begun = await beginOAuthConnection({
    workspace: parseWorkspaceUrl(ORIGIN),
    redirectUri: REDIRECT,
    storage,
    fetchImpl,
    now,
  });
  assert.equal(new URL(begun.authorizationUrl).searchParams.get('code_challenge_method'), 'S256');
  assert.equal(new URL(begun.authorizationUrl).searchParams.get('resource'), `${ORIGIN}/mcp-server/http`);
  assert.deepEqual(
    new URL(begun.authorizationUrl).searchParams.get('scope')?.split(' '),
    [
      'workflow:read',
      'workflow:write',
      'credential:read',
      'workflow:execute',
      'execution:read',
    ],
  );
  assert.ok(storage.get('meka.n8n.installer.oauth'));

  const callback = new URL(REDIRECT);
  callback.searchParams.set('state', begun.session.state);
  callback.searchParams.set('code', 'one-time-code');
  callback.searchParams.set('iss', ORIGIN);
  const result = await finishOAuthConnection({
    callbackUrl: callback.toString(),
    storage,
    fetchImpl,
    now: now + 1_000,
  });
  assert.equal(result.accessToken, 'memory-only-token');
  assert.equal(storage.get('meka.n8n.installer.oauth'), null);
  await assert.rejects(
    finishOAuthConnection({ callbackUrl: callback.toString(), storage, fetchImpl, now }),
    { code: 'OAUTH_SESSION_MISSING' },
  );
});

test('OAuth callback rejects cancel, expiry, issuer mismatch, and callback replacement', async () => {
  const scenarios = [
    {
      code: 'OAUTH_CANCELLED',
      nowOffset: 0,
      issuer: ORIGIN,
      error: 'access_denied',
      redirect: REDIRECT,
    },
    {
      code: 'OAUTH_SESSION_EXPIRED',
      nowOffset: OAUTH_TTL_MS + 1,
      issuer: ORIGIN,
      redirect: REDIRECT,
    },
    {
      code: 'OAUTH_ISSUER_MISMATCH',
      nowOffset: 0,
      issuer: 'https://attacker.example',
      redirect: REDIRECT,
    },
    {
      code: 'OAUTH_CALLBACK_MISMATCH',
      nowOffset: 0,
      issuer: ORIGIN,
      redirect: 'https://installer.example/different/',
    },
  ];

  for (const scenario of scenarios) {
    const { fetchImpl } = oauthFetch();
    const storage = createMemorySessionStore();
    const now = 1_800_000_000_000;
    const begun = await beginOAuthConnection({
      workspace: ORIGIN,
      redirectUri: REDIRECT,
      storage,
      fetchImpl,
      now,
    });
    const callback = new URL(scenario.redirect);
    callback.searchParams.set('state', begun.session.state);
    callback.searchParams.set('code', 'one-time-code');
    callback.searchParams.set('iss', scenario.issuer);
    if (scenario.error) callback.searchParams.set('error', scenario.error);
    await assert.rejects(
      finishOAuthConnection({
        callbackUrl: callback.toString(),
        storage,
        fetchImpl,
        now: now + scenario.nowOffset,
      }),
      { code: scenario.code },
    );
    assert.equal(storage.get('meka.n8n.installer.oauth'), null);
  }
});

test('redirect URI and relay policy allow only exact manual execution reads', () => {
  assert.throws(() => normalizeRedirectUri('https://installer.example/?next=evil'), {
    code: 'REDIRECT_URI_INVALID',
  });
  assert.equal(validateRelayTarget(ORIGIN).mcpUrl, `${ORIGIN}/mcp-server/http`);
  assert.throws(() => validateRelayTarget('https://attacker.example'), InstallerError);

  const toolCall = (name, args) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const workflowCode = '// LinkedIn jobs to Google Sheets (Cloud auto-setup)';
  assert.deepEqual(validateMcpRpcBody(toolCall('validate_workflow', { code: workflowCode })), {
    method: 'tools/call',
    toolName: 'validate_workflow',
    toolArguments: { code: workflowCode },
  });
  assert.deepEqual(validateMcpRpcBody(toolCall('execute_workflow', {
    workflowId: 'workflow-123',
    executionMode: 'manual',
    triggerNodeName: 'Manual Trigger',
  })), {
    method: 'tools/call',
    toolName: 'execute_workflow',
    toolArguments: {
      workflowId: 'workflow-123',
      executionMode: 'manual',
      triggerNodeName: 'Manual Trigger',
    },
  });
  assert.deepEqual(validateMcpRpcBody(toolCall('get_workflow_execution', {
    workflowId: 'workflow-123',
    executionId: 'execution-123',
    includeData: false,
  })), {
    method: 'tools/call',
    toolName: 'get_workflow_execution',
    toolArguments: {
      workflowId: 'workflow-123',
      executionId: 'execution-123',
      includeData: false,
    },
  });

  assert.deepEqual(RELAY_ALLOWED_NODE_SETS.apifyConnectionCheck, [
    'Manual Trigger',
    'Check Apify OAuth',
    'Assess Apify Connection',
    'Connection Check Summary',
  ]);
  assert.deepEqual(RELAY_ALLOWED_NODE_SETS.googleConnectionCheck, [
    'Manual Trigger',
    'Check Google OAuth',
    'Assess Google Connection',
    'Connection Check Summary',
  ]);
  for (const nodeNames of Object.values(RELAY_ALLOWED_NODE_SETS)) {
    assert.deepEqual(validateMcpRpcBody(toolCall('get_workflow_execution', {
      workflowId: 'workflow-123',
      executionId: 'execution-123',
      includeData: true,
      nodeNames: [...nodeNames],
      truncateData: 1,
    })), {
      method: 'tools/call',
      toolName: 'get_workflow_execution',
      toolArguments: {
        workflowId: 'workflow-123',
        executionId: 'execution-123',
        includeData: true,
        nodeNames: [...nodeNames],
        truncateData: 1,
      },
    });
  }

  for (const code of [
    '// MEKA account check · legacy',
    '// MEKA Apify account check · new',
    '// MEKA Google account check · new',
  ]) {
    assert.equal(
      validateMcpRpcBody(toolCall('validate_workflow', { code })).toolArguments.code,
      code,
    );
  }
  for (const code of [
    '// MEKA Enterprise account check · new',
    '// MEKA Apify Account check · new',
    '// MEKA Google account checks · new',
  ]) {
    assert.throws(
      () => validateMcpRpcBody(toolCall('validate_workflow', { code })),
      { code: 'RELAY_ARGUMENTS_REFUSED' },
    );
  }

  const apifyNodes = RELAY_ALLOWED_NODE_SETS.apifyConnectionCheck;
  for (const nodeNames of [
    [...apifyNodes, 'Unexpected Node'],
    apifyNodes.filter((name) => name !== 'Check Apify OAuth'),
    [...apifyNodes, 'Connection Check Summary'],
    apifyNodes.map((name) => (
      name === 'Assess Apify Connection' ? 'Assess Apify Credential' : name
    )),
  ]) {
    assert.throws(() => validateMcpRpcBody(toolCall('get_workflow_execution', {
      workflowId: 'workflow-123',
      executionId: 'execution-123',
      includeData: true,
      nodeNames,
      truncateData: 1,
    })), { code: 'RELAY_ARGUMENTS_REFUSED' });
  }

  for (const body of [
    toolCall('execute_workflow', {
      workflowId: 'workflow-123',
      executionMode: 'manual',
      triggerNodeName: 'Manual Trigger',
      extra: true,
    }),
    toolCall('execute_workflow', {
      workflowId: 'workflow-123',
      executionMode: 'production',
      triggerNodeName: 'Manual Trigger',
    }),
    toolCall('get_workflow_execution', {
      workflowId: 'workflow-123',
      executionId: 'execution-123',
      includeData: true,
      nodeNames: ['Run Summary'],
      truncateData: 1,
    }),
    toolCall('get_workflow_execution', {
      workflowId: 'workflow-123',
      executionId: 'execution-123',
      includeData: false,
      extra: true,
    }),
  ]) {
    assert.throws(() => validateMcpRpcBody(body), InstallerError);
  }
  for (const name of [
    'publish_workflow',
    'archive_workflow',
    'install_community_node',
    'test_workflow',
  ]) {
    assert.throws(() => validateMcpRpcBody({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: {} },
    }), { code: 'RELAY_TOOL_REFUSED' });
  }
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('100.64.0.1'), true);
  assert.equal(isPrivateAddress('0.0.0.0'), true);
  assert.equal(isPrivateAddress('224.0.0.1'), true);
  assert.equal(isPrivateAddress('fd00::1'), true);
  assert.equal(isPrivateAddress('::'), true);
  assert.equal(isPrivateAddress('0:0:0:0:0:0:0:0'), true);
  assert.equal(isPrivateAddress('0:0:0:0:0:0:0:1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('0:0:0:0:0:ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('ff02::1'), true);
  assert.equal(isPrivateAddress('not-an-ip'), true);
  assert.equal(isPrivateAddress('203.0.114.8'), false);
});

test('single-service execution responses expose only the safe connection summary', () => {
  const cases = [
    {
      set: RELAY_ALLOWED_NODE_SETS.apifyConnectionCheck,
      workflowId: 'workflow-apify',
      executionId: 'execution-apify',
      serviceField: 'apifyStatus',
      droppedServiceField: 'googleStatus',
      checkNode: 'Check Apify OAuth',
    },
    {
      set: RELAY_ALLOWED_NODE_SETS.googleConnectionCheck,
      workflowId: 'workflow-google',
      executionId: 'execution-google',
      serviceField: 'googleStatus',
      droppedServiceField: 'apifyStatus',
      checkNode: 'Check Google OAuth',
    },
  ];

  for (const scenario of cases) {
    const args = {
      workflowId: scenario.workflowId,
      executionId: scenario.executionId,
      includeData: true,
      nodeNames: [...scenario.set],
      truncateData: 1,
    };
    const leakedValues = [
      'CHECK_NODE_RAW_RESPONSE_SHOULD_NOT_LEAK',
      'Bearer upstream-access-token-should-not-leak',
      'credential-secret-should-not-leak',
      'environment-secret-should-not-leak',
      'summary-extra-field-should-not-leak',
    ];
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      result: {
        structuredContent: {
          execution: {
            id: scenario.executionId,
            workflowId: scenario.workflowId,
            status: 'success',
          },
          data: {
            resultData: {
              runData: {
                [scenario.checkNode]: [{
                  data: {
                    main: [[{
                      json: {
                        response: leakedValues[0],
                        headers: {
                          authorization: leakedValues[1],
                        },
                        credentialId: leakedValues[2],
                        environment: leakedValues[3],
                      },
                    }]],
                  },
                }],
                'Connection Check Summary': [{
                  data: {
                    main: [[{
                      json: {
                        status: 'ok',
                        workflowId: scenario.workflowId,
                        executionId: scenario.executionId,
                        [scenario.serviceField]: 'ok',
                        [scenario.droppedServiceField]: null,
                        rawResponse: leakedValues[0],
                        authorization: leakedValues[1],
                        credential: leakedValues[2],
                        environment: leakedValues[3],
                        evidence: leakedValues[4],
                      },
                    }]],
                  },
                }],
              },
            },
          },
        },
      },
    });
    const sanitized = new TextDecoder().decode(sanitizeMcpResponseBody({
      toolName: 'get_workflow_execution',
      arguments: args,
      contentType: 'application/json',
      body: new TextEncoder().encode(body),
    }));
    const sanitizedBody = JSON.parse(sanitized);
    const value = sanitizedBody.result.structuredContent;

    assert.deepEqual(value, {
      execution: {
        id: scenario.executionId,
        workflowId: scenario.workflowId,
        status: 'success',
      },
      summary: {
        status: 'ok',
        [scenario.serviceField]: 'ok',
        workflowId: scenario.workflowId,
        executionId: scenario.executionId,
      },
      hasPinnedServiceData: 'unknown',
      responsePolicy: 'execution-response-v1',
    });
    assert.equal(
      Object.hasOwn(value.summary, scenario.droppedServiceField),
      false,
    );
    for (const leaked of leakedValues) {
      assert.doesNotMatch(sanitized, new RegExp(leaked, 'u'));
    }
  }
});
