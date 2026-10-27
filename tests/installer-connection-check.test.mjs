import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTION_CHECK_NODE_NAMES,
  CONNECTION_CHECK_TEMPLATE_VERSION,
  connectionCheckRequiresHelperReset,
  connectionEvidenceIsCurrent,
  invalidateConnectionCheck,
  renderConnectionResponseStatusCode,
  resetTerminalConnectionCheckAttempt,
  runConnectionCheck,
  verifyConnectionCheckWorkflow,
} from '../installer/lib/connection-check.js';
import {
  APIFY_CREDENTIAL_TYPE,
  GOOGLE_CREDENTIAL_TYPE,
} from '../installer/lib/credentials.js';
import {
  claimConnectionCheck,
  releaseConnectionCheck,
} from '../installer/lib/app-controller.js';

const WORKSPACE = 'https://meka-test.app.n8n.cloud';
const CHECK_WORKFLOW_ID = 'check-workflow-123';
const CHECK_EXECUTION_ID = 'check-execution-123';
const CHECK_VERSION_ID = 'check-version-123';
const CHECK_FINGERPRINT = 'b'.repeat(64);
const identity = {
  name: 'MEKA account check · ABCD2345',
  nonce: 'ABCD2345',
  description: 'Created by the MEKA installer ABCD2345 for read-only account checks.',
};
const apify = {
  id: 'apify-credential-1',
  name: 'Apify OAuth',
  type: APIFY_CREDENTIAL_TYPE,
};
const google = {
  id: 'google-credential-1',
  name: 'Google Sheets OAuth',
  type: GOOGLE_CREDENTIAL_TYPE,
};

function summaryCode() {
  return `const apify = $('Assess Apify Connection').first()?.json ?? {};
const google = $('Assess Google Connection').first()?.json ?? {};
const checked = apify.status === 'ok' && google.status === 'ok';
return [{
  json: {
    workflowId: String($workflow?.id ?? ''),
    executionId: String($execution?.id ?? ''),
    status: checked ? 'checked' : 'failed',
    apifyStatus: typeof apify.status === 'string' ? apify.status : 'invalid-response',
    googleStatus: typeof google.status === 'string' ? google.status : 'invalid-response'
  }
}];
`;
}

function checkWorkflowDetails(overrides = {}) {
  const nodes = [
    {
      id: 'c7bb4317-b4f2-4ef7-9629-e0671d4ccf01',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      parameters: {},
      position: [-720, 0],
    },
    {
      id: '2b9697c1-6356-48b9-88b4-f42830563b0b',
      name: 'Check Apify OAuth',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      parameters: {
        method: 'GET',
        url: 'https://api.apify.com/v2/users/me',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: APIFY_CREDENTIAL_TYPE,
        options: {
          response: {
            response: {
              fullResponse: true,
              responseFormat: 'json',
              neverError: true,
            },
          },
          timeout: 15000,
        },
      },
      credentials: {
        [APIFY_CREDENTIAL_TYPE]: {
          id: apify.id,
          name: apify.name,
        },
      },
      position: [-480, 0],
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
      retryOnFail: false,
    },
    {
      id: '16cfa94d-5d5d-4681-b57c-037e9a7ad8e6',
      name: 'Assess Apify Connection',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: renderConnectionResponseStatusCode('apify'),
      },
      position: [-240, 0],
    },
    {
      id: '8fb3b2f0-1937-4731-9d13-1b9c42daf821',
      name: 'Check Google OAuth',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      parameters: {
        method: 'GET',
        url: 'https://www.googleapis.com/drive/v3/files?fields=files(id)&pageSize=1',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: GOOGLE_CREDENTIAL_TYPE,
        options: {
          response: {
            response: {
              fullResponse: true,
              responseFormat: 'json',
              neverError: true,
            },
          },
          timeout: 15000,
        },
      },
      credentials: {
        [GOOGLE_CREDENTIAL_TYPE]: {
          id: google.id,
          name: google.name,
        },
      },
      position: [0, 0],
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
      retryOnFail: false,
    },
    {
      id: '43c1b775-32e0-4c13-9b99-5b87c8c34499',
      name: 'Assess Google Connection',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: renderConnectionResponseStatusCode('google'),
      },
      position: [240, 0],
    },
    {
      id: 'dc6f2612-741d-48f0-98d0-1de99080fa71',
      name: 'Connection Check Summary',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: summaryCode(),
      },
      position: [480, 0],
    },
  ];
  const connections = {
    'Manual Trigger': {
      main: [[{ node: 'Check Apify OAuth', type: 'main', index: 0 }]],
    },
    'Check Apify OAuth': {
      main: [[{ node: 'Assess Apify Connection', type: 'main', index: 0 }]],
    },
    'Assess Apify Connection': {
      main: [[{ node: 'Check Google OAuth', type: 'main', index: 0 }]],
    },
    'Check Google OAuth': {
      main: [[{ node: 'Assess Google Connection', type: 'main', index: 0 }]],
    },
    'Assess Google Connection': {
      main: [[{ node: 'Connection Check Summary', type: 'main', index: 0 }]],
    },
  };
  const workflow = {
    id: CHECK_WORKFLOW_ID,
    name: identity.name,
    active: false,
    versionId: CHECK_VERSION_ID,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      timezone: 'UTC',
      availableInMCP: true,
    },
    ...overrides,
  };
  return { workflow };
}

function checkState(overrides = {}) {
  return {
    createAttempted: true,
    status: 'installed-pending-test',
    workflowId: 'main-workflow-123',
    workspaceOrigin: WORKSPACE,
    connectionCheck: {
      status: 'unknown',
      phase: 'polling-timeout',
      identity,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      apifyCredentialName: apify.name,
      googleCredentialName: google.name,
      createAttempted: true,
      executionRequested: true,
      executionId: CHECK_EXECUTION_ID,
      workflowId: CHECK_WORKFLOW_ID,
      openUrl: `${WORKSPACE}/workflow/${CHECK_WORKFLOW_ID}`,
      workflowVersionId: CHECK_VERSION_ID,
      workflowVersionFingerprint: CHECK_FINGERPRINT,
      templateVersion: CONNECTION_CHECK_TEMPLATE_VERSION,
      evidence: null,
      ...overrides,
    },
  };
}

function resumeClient({
  selectedApify = apify,
  selectedGoogle = google,
  summary = {
    workflowId: CHECK_WORKFLOW_ID,
    executionId: CHECK_EXECUTION_ID,
    status: 'checked',
    apifyStatus: 'ok',
    googleStatus: 'ok',
  },
} = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async requireTools() {},
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === 'list_credentials') {
          const data = args.type === APIFY_CREDENTIAL_TYPE
            ? [
              apify,
              { ...apify, id: selectedApify.id, name: selectedApify.name },
            ]
            : [
              google,
              { ...google, id: selectedGoogle.id, name: selectedGoogle.name },
            ];
          return { count: new Set(data.map((item) => item.id)).size, data };
        }
        if (name === 'get_workflow_details') {
          return checkWorkflowDetails();
        }
        if (name === 'get_workflow_execution') {
          if (args.includeData === true) {
            return {
              execution: {
                id: CHECK_EXECUTION_ID,
                workflowId: CHECK_WORKFLOW_ID,
                mode: 'manual',
                status: 'success',
                startedAt: '2026-10-27T00:00:00.000Z',
                stoppedAt: '2026-10-27T00:00:01.000Z',
              },
              summary,
              hasPinnedServiceData: false,
              responsePolicy: 'execution-response-v1',
            };
          }
          return {
            execution: {
              id: CHECK_EXECUTION_ID,
              workflowId: CHECK_WORKFLOW_ID,
              mode: 'manual',
              status: 'success',
              startedAt: '2026-10-27T00:00:00.000Z',
              stoppedAt: '2026-10-27T00:00:01.000Z',
            },
            responsePolicy: 'execution-response-v1',
          };
        }
        throw new Error(`unexpected tool ${name}`);
      },
    },
  };
}

function executeResponseStatus(payload, service = 'google') {
  const code = renderConnectionResponseStatusCode(service);
  const input = { json: payload };
  const result = new Function('$input', code)({
    first: () => input,
  });
  return result[0].json;
}

test('connection response status code classifies failures without exposing upstream text', () => {
  assert.deepEqual(executeResponseStatus({ statusCode: 200 }), {
    service: 'google',
    status: 'ok',
    httpStatus: null,
  });
  assert.equal(
    executeResponseStatus({ statusCode: 429 }).status,
    'rate-limited',
  );
  assert.equal(
    executeResponseStatus({ statusCode: 401 }).status,
    'authorization-failed',
  );
  assert.equal(
    executeResponseStatus({ statusCode: 403 }).status,
    'authorization-failed',
  );
  assert.equal(
    executeResponseStatus({ statusCode: 503 }).status,
    'temporary-unavailable',
  );
  assert.equal(
    executeResponseStatus({
      statusCode: 403,
      body: {
        error: {
          errors: [{
            reason: 'rateLimitExceeded',
            message: 'quota-project@example.invalid',
          }],
          details: [{ reason: 'RATE_LIMIT_EXCEEDED' }],
          message: 'project-account-sentinel',
        },
      },
    }).status,
    'rate-limited',
  );
  assert.equal(
    executeResponseStatus({
      error: {
        description: '403 - JSON: {"error":{"details":[{"reason":"RATE_LIMIT_EXCEEDED"}],"message":"raw-sentinel"}}',
        cause: {
          message: '403 - JSON: {"error":{"errors":[{"reason":"userRateLimitExceeded"}],"message":"cause-sentinel"}}',
        },
      },
    }).status,
    'rate-limited',
  );
  assert.equal(
    executeResponseStatus({
      statusCode: 403,
      body: { error: { message: 'rateLimitExceeded but no structured reason' } },
    }).status,
    'authorization-failed',
  );
  assert.equal(
    executeResponseStatus({
      error: { message: 'Credentials not found' },
    }).status,
    'not-connected',
  );
  const actualDisconnectedShape = {
    error: {
      name: 'NodeApiError',
      message: 'Unable to sign without access token',
      cause: {
        message: 'Unable to sign without access token',
        privateValue: 'disconnected-private-sentinel',
      },
    },
  };
  assert.equal(
    executeResponseStatus(actualDisconnectedShape).status,
    'not-connected',
  );
  assert.equal(
    executeResponseStatus({
      error: {
        message: 'prefix Unable to sign without access token',
        cause: { message: 'Unable to sign without access token suffix' },
      },
    }).status,
    'blocked',
  );
  const unknown = executeResponseStatus({
    error: {
      message: 'request failed for user@example.invalid with raw-token-sentinel',
    },
  });
  assert.equal(unknown.status, 'blocked');
  assert.equal(
    JSON.stringify(unknown).includes('example.invalid'),
    false,
  );
  assert.equal(JSON.stringify(unknown).includes('sentinel'), false);
  assert.equal(
    JSON.stringify(executeResponseStatus(actualDisconnectedShape)).includes('sentinel'),
    false,
  );
});

test('connection check verifier binds the exact helper graph and exposed credential references', async () => {
  const verified = await verifyConnectionCheckWorkflow({
    details: checkWorkflowDetails(),
    workflowId: CHECK_WORKFLOW_ID,
    workflowName: identity.name,
    workspaceOrigin: WORKSPACE,
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    apifyCredentialName: apify.name,
    googleCredentialName: google.name,
  });
  assert.equal(verified.credentialReferenceReadback, 'verified');
  assert.equal(verified.credentialReferenceCount, 2);
  assert.equal(verified.templateVersion, CONNECTION_CHECK_TEMPLATE_VERSION);

  const changedCode = checkWorkflowDetails();
  changedCode.workflow.nodes[2].parameters.jsCode = "return [{ json: { status: 'ok' } }];";
  await assert.rejects(
    verifyConnectionCheckWorkflow({
      details: changedCode,
      workflowId: CHECK_WORKFLOW_ID,
      workflowName: identity.name,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      apifyCredentialName: apify.name,
      googleCredentialName: google.name,
    }),
    { code: 'CONNECTION_CHECK_GRAPH_MISMATCH' },
  );

  const changedFullResponse = checkWorkflowDetails();
  changedFullResponse.workflow.nodes[1].parameters.options.response.response.neverError = false;
  await assert.rejects(
    verifyConnectionCheckWorkflow({
      details: changedFullResponse,
      workflowId: CHECK_WORKFLOW_ID,
      workflowName: identity.name,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      apifyCredentialName: apify.name,
      googleCredentialName: google.name,
    }),
    { code: 'CONNECTION_CHECK_GRAPH_MISMATCH' },
  );

  const changedGraph = checkWorkflowDetails();
  changedGraph.workflow.connections = {};
  await assert.rejects(
    verifyConnectionCheckWorkflow({
      details: changedGraph,
      workflowId: CHECK_WORKFLOW_ID,
      workflowName: identity.name,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      apifyCredentialName: apify.name,
      googleCredentialName: google.name,
    }),
    { code: 'CONNECTION_CHECK_GRAPH_MISMATCH' },
  );

  const hiddenCredentials = checkWorkflowDetails();
  for (const node of hiddenCredentials.workflow.nodes) delete node.credentials;
  const hidden = await verifyConnectionCheckWorkflow({
    details: hiddenCredentials,
    workflowId: CHECK_WORKFLOW_ID,
    workflowName: identity.name,
    workspaceOrigin: WORKSPACE,
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    apifyCredentialName: apify.name,
    googleCredentialName: google.name,
  });
  assert.equal(hidden.credentialReferenceReadback, 'not-exposed');

  const wrongCredential = checkWorkflowDetails();
  wrongCredential.workflow.nodes[1].credentials[APIFY_CREDENTIAL_TYPE].id = 'other-apify';
  await assert.rejects(
    verifyConnectionCheckWorkflow({
      details: wrongCredential,
      workflowId: CHECK_WORKFLOW_ID,
      workflowName: identity.name,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      apifyCredentialName: apify.name,
      googleCredentialName: google.name,
    }),
    { code: 'CONNECTION_CHECK_CREDENTIAL_MISMATCH' },
  );
});

test('a recorded connection-check execution resumes the same ID and reaches final readback', async () => {
  const { client, calls } = resumeClient();
  const state = checkState();
  let verifyCalls = 0;
  const evidence = await runConnectionCheck({
    client,
    workspaceOrigin: WORKSPACE,
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    nonce: identity.nonce,
    state,
    maxPolls: 1,
    pollIntervalMs: 0,
    wait: async () => {},
    now: Date.parse('2026-10-27T00:00:02.000Z'),
    verifyWorkflow: async () => {
      verifyCalls += 1;
      return {
        workflowId: CHECK_WORKFLOW_ID,
        workflowVersionId: CHECK_VERSION_ID,
        workflowVersionFingerprint: CHECK_FINGERPRINT,
        templateVersion: CONNECTION_CHECK_TEMPLATE_VERSION,
        credentialReferenceReadback: 'verified',
        openUrl: `${WORKSPACE}/workflow/${CHECK_WORKFLOW_ID}`,
      };
    },
  });

  assert.equal(evidence.executionId, CHECK_EXECUTION_ID);
  assert.equal(evidence.workflowVersionId, CHECK_VERSION_ID);
  assert.equal(evidence.apifyStatus, 'ok');
  assert.equal(evidence.googleStatus, 'ok');
  assert.equal(verifyCalls, 1);
  assert.equal(calls.some(({ name }) => name === 'execute_workflow'), false);
  assert.equal(
    calls.filter(({ name }) => name === 'get_workflow_execution').length,
    2,
  );
  assert.equal(state.connectionCheck.status, 'checked');
  assert.equal(state.status, 'installed-pending-test');
  assert.equal(
    calls.filter(({ name, args }) => (
      name === 'get_workflow_execution'
      && args.includeData === true
      && args.nodeNames.length === CONNECTION_CHECK_NODE_NAMES.length
    )).length,
    1,
  );
});

test('strict helper summaries accept only current statuses and do not guide rate limits to reconnect', async () => {
  const verifyWorkflow = async () => ({
    workflowId: CHECK_WORKFLOW_ID,
    workflowVersionId: CHECK_VERSION_ID,
    workflowVersionFingerprint: CHECK_FINGERPRINT,
    templateVersion: CONNECTION_CHECK_TEMPLATE_VERSION,
    credentialReferenceReadback: 'verified',
    openUrl: `${WORKSPACE}/workflow/${CHECK_WORKFLOW_ID}`,
  });
  const state = checkState();
  const { client, calls } = resumeClient({
    summary: {
      workflowId: CHECK_WORKFLOW_ID,
      executionId: CHECK_EXECUTION_ID,
      status: 'failed',
      apifyStatus: 'ok',
      googleStatus: 'rate-limited',
      rawReason: 'project@example.invalid raw-token-sentinel',
    },
  });
  let received;
  await assert.rejects(
    runConnectionCheck({
      client,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      nonce: identity.nonce,
      state,
      maxPolls: 1,
      pollIntervalMs: 0,
      wait: async () => {},
      verifyWorkflow,
    }),
    (error) => {
      received = error;
      return error.code === 'CONNECTION_CHECK_FAILED';
    },
  );
  assert.equal(state.connectionCheck.googleStatus, 'rate-limited');
  assert.equal(
    received.safeDetails.googleCredentialUrl,
    undefined,
  );
  assert.equal(
    JSON.stringify(state).includes('example.invalid'),
    false,
  );
  assert.equal(JSON.stringify(state).includes('sentinel'), false);
  assert.equal(calls.some(({ name }) => name === 'execute_workflow'), false);

  const legacyState = checkState();
  const legacy = resumeClient({
    summary: {
      workflowId: CHECK_WORKFLOW_ID,
      executionId: CHECK_EXECUTION_ID,
      status: 'failed',
      apifyStatus: 'ok',
      googleStatus: 'http-error',
    },
  });
  await assert.rejects(
    runConnectionCheck({
      client: legacy.client,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      nonce: identity.nonce,
      state: legacyState,
      maxPolls: 1,
      pollIntervalMs: 0,
      wait: async () => {},
      verifyWorkflow,
    }),
    { code: 'CONNECTION_CHECK_SUMMARY_INVALID' },
  );
});

test('only a known terminal stale helper can be explicitly reset and retained for audit', async () => {
  const state = checkState({
    status: 'failed',
    phase: 'complete',
    templateVersion: '1',
    apifyStatus: 'ok',
    googleStatus: 'authorization-failed',
  });
  assert.equal(connectionCheckRequiresHelperReset(state.connectionCheck), true);

  const { client, calls } = resumeClient();
  await assert.rejects(
    runConnectionCheck({
      client,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      nonce: 'EFGH6789',
      state,
    }),
    (error) => (
      error.code === 'CHECK_HELPER_RESET_REQUIRED'
      && error.safeDetails.executionUrl
        === `${WORKSPACE}/workflow/${CHECK_WORKFLOW_ID}/executions/${CHECK_EXECUTION_ID}`
    ),
  );
  assert.equal(
    calls.some(({ name }) => (
      name === 'create_workflow_from_code'
      || name === 'execute_workflow'
      || name === 'get_workflow_details'
    )),
    false,
  );
  assert.equal(state.connectionCheck.workflowId, CHECK_WORKFLOW_ID);
  assert.equal(state.connectionCheck.executionId, CHECK_EXECUTION_ID);

  resetTerminalConnectionCheckAttempt(state, {
    now: Date.parse('2026-10-27T00:00:03.000Z'),
  });
  assert.equal(state.connectionCheck.status, 'not-checked');
  assert.equal(state.connectionCheck.createAttempted, false);
  assert.equal(state.connectionCheck.executionRequested, false);
  assert.equal(state.connectionCheck.workflowId, null);
  assert.equal(state.connectionCheck.executionId, null);
  assert.deepEqual(state.connectionCheck.resetAttempt, {
    previousWorkflowId: CHECK_WORKFLOW_ID,
    previousExecutionId: CHECK_EXECUTION_ID,
    previousOpenUrl: `${WORKSPACE}/workflow/${CHECK_WORKFLOW_ID}`,
    previousTemplateVersion: '1',
    resetAt: '2026-10-27T00:00:03.000Z',
  });

  const replacement = {
    async requireTools() {},
    async callTool(name, args) {
      if (name === 'list_credentials') {
        return {
          count: 1,
          data: [args.type === APIFY_CREDENTIAL_TYPE ? apify : google],
        };
      }
      if (name === 'validate_workflow') return { valid: true };
      if (name === 'create_workflow_from_code') {
        throw new Error('stop before a replacement workflow exists');
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  await assert.rejects(
    runConnectionCheck({
      client: replacement,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      nonce: 'EFGH6789',
      state,
    }),
    { code: 'CHECK_CREATE_RESULT_UNKNOWN' },
  );
  assert.equal(state.connectionCheck.createAttempted, true);
  assert.deepEqual(state.connectionCheck.resetAttempt, {
    previousWorkflowId: CHECK_WORKFLOW_ID,
    previousExecutionId: CHECK_EXECUTION_ID,
    previousOpenUrl: `${WORKSPACE}/workflow/${CHECK_WORKFLOW_ID}`,
    previousTemplateVersion: '1',
    resetAt: '2026-10-27T00:00:03.000Z',
  });

  const unknown = checkState({
    status: 'unknown',
    phase: 'polling-timeout',
    templateVersion: '1',
  });
  assert.throws(
    () => resetTerminalConnectionCheckAttempt(unknown),
    { code: 'CONNECTION_CHECK_RESET_NOT_ALLOWED' },
  );
  const missingExecution = checkState({
    status: 'failed',
    phase: 'complete',
    templateVersion: '1',
    executionRequested: true,
    executionId: null,
  });
  assert.throws(
    () => resetTerminalConnectionCheckAttempt(missingExecution),
    { code: 'CONNECTION_CHECK_RESET_NOT_ALLOWED' },
  );
  const missingWorkflow = checkState({
    status: 'failed',
    phase: 'complete',
    templateVersion: '1',
    workflowId: null,
  });
  assert.throws(
    () => resetTerminalConnectionCheckAttempt(missingWorkflow),
    (error) => (
      error.code === 'CONNECTION_CHECK_RESET_NOT_ALLOWED'
      && error.safeDetails.executionUrl === null
    ),
  );
});

test('changing credentials while execution or creation is unresolved blocks another helper run', async () => {
  const knownExecution = resumeClient({
    selectedApify: { id: 'apify-credential-2', name: 'Other Apify' },
  });
  const executionState = checkState();
  await assert.rejects(
    runConnectionCheck({
      client: knownExecution.client,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: 'apify-credential-2',
      googleCredentialId: google.id,
      nonce: 'EFGH6789',
      state: executionState,
      verifyWorkflow: async () => {
        throw new Error('verification must not run');
      },
    }),
    (error) => (
      error.code === 'CHECK_BINDING_CHANGED_UNKNOWN'
      && error.safeDetails.workflowUrl.endsWith(`/workflow/${CHECK_WORKFLOW_ID}`)
    ),
  );
  assert.equal(
    knownExecution.calls.some(({ name }) => name === 'execute_workflow'),
    false,
  );

  const unknownCreation = resumeClient({
    selectedApify: { id: 'apify-credential-2', name: 'Other Apify' },
  });
  const creationState = checkState({
    status: 'unknown',
    phase: 'create-requested',
    executionRequested: false,
    executionId: null,
    workflowId: null,
    openUrl: null,
    workflowVersionId: null,
    workflowVersionFingerprint: null,
  });
  await assert.rejects(
    runConnectionCheck({
      client: unknownCreation.client,
      workspaceOrigin: WORKSPACE,
      apifyCredentialId: 'apify-credential-2',
      googleCredentialId: google.id,
      nonce: 'EFGH6789',
      state: creationState,
      verifyWorkflow: async () => {
        throw new Error('verification must not run');
      },
    }),
    { code: 'CHECK_BINDING_CHANGED_UNKNOWN' },
  );
  assert.equal(
    unknownCreation.calls.some(({ name }) => (
      name === 'create_workflow_from_code' || name === 'execute_workflow'
    )),
    false,
  );
});

test('invalidation preserves unresolved IDs while allowing a failed check to be retried', () => {
  const unresolved = checkState();
  unresolved.connectionCheck.evidence = {
    version: 1,
    checkedAt: '2026-10-27T00:00:02.000Z',
  };
  unresolved.connectionCheck.status = 'unknown';
  invalidateConnectionCheck(unresolved, 'credentials-changed');
  assert.equal(unresolved.connectionCheck.status, 'unknown');
  assert.equal(unresolved.connectionCheck.executionId, CHECK_EXECUTION_ID);
  assert.equal(unresolved.connectionCheck.executionRequested, true);
  assert.equal(unresolved.connectionCheck.evidence, null);

  const failed = checkState({
    status: 'failed',
    executionRequested: false,
    executionId: null,
    evidence: null,
  });
  invalidateConnectionCheck(failed, 'credentials-changed');
  assert.equal(failed.connectionCheck.status, 'not-checked');

  const claimState = {
    connectionCheck: checkState().connectionCheck,
  };
  claimState.connectionCheck.executionId = null;
  assert.deepEqual(claimConnectionCheck(claimState), {
    allowed: false,
    reason: 'execution-unknown',
  });
  claimState.connectionCheck = {
    status: 'failed',
    phase: 'execute-rejected',
    executionRequested: true,
    executionId: null,
  };
  assert.equal(claimConnectionCheck(claimState).allowed, true);
  releaseConnectionCheck(claimState);
});

test('connection evidence expires and is bound to both version and credentials', () => {
  const checkedAt = Date.parse('2026-10-27T00:00:02.000Z');
  const evidence = {
    version: 1,
    workspaceOrigin: WORKSPACE,
    workflowId: CHECK_WORKFLOW_ID,
    workflowVersionId: CHECK_VERSION_ID,
    workflowVersionFingerprint: CHECK_FINGERPRINT,
    executionId: CHECK_EXECUTION_ID,
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    apifyStatus: 'ok',
    googleStatus: 'ok',
    checkedAt: new Date(checkedAt).toISOString(),
  };
  assert.equal(connectionEvidenceIsCurrent(evidence, {
    workspaceOrigin: WORKSPACE,
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    now: checkedAt + 1,
  }), true);
  assert.equal(connectionEvidenceIsCurrent({
    ...evidence,
    workflowVersionId: undefined,
  }, {
    workspaceOrigin: WORKSPACE,
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    now: checkedAt + 1,
  }), false);
  assert.equal(connectionEvidenceIsCurrent(evidence, {
    workspaceOrigin: WORKSPACE,
    apifyCredentialId: 'other-apify',
    googleCredentialId: google.id,
    now: checkedAt + 1,
  }), false);
  assert.equal(connectionEvidenceIsCurrent(evidence, {
    workspaceOrigin: WORKSPACE,
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    now: checkedAt + 10 * 60 * 1000 + 1,
  }), false);
});
