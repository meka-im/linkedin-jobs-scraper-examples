import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessTestSummary,
  runManualSmallTest,
} from '../installer/lib/test-run.js';

const WORKSPACE = 'https://meka-test.app.n8n.cloud';
const WORKFLOW_ID = 'main-workflow-123';
const VERSION_ID = 'main-version-1';
const EXECUTION_ID = 'main-execution-123';
const NOW = Date.parse('2026-10-27T00:00:00.000Z');
const apifyCredentialId = 'apify-credential-1';
const googleCredentialId = 'google-credential-1';

const manifest = {
  nodeCount: 1,
  connectionCount: 0,
  nodes: [{
    name: 'Run Summary',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: 'return [{ json: {} }];',
    },
    executionOptions: {
      retryOnFail: false,
      maxTries: null,
      waitBetweenTries: null,
      alwaysOutputData: false,
      continueOnFail: false,
      onError: 'stopWorkflow',
      executeOnce: false,
      disabled: false,
    },
  }],
  connections: {},
  credentialNodeCounts: {
    apify: 0,
    google: 0,
  },
};

function workflowDetails(versionId = VERSION_ID) {
  return {
    workflow: {
      id: WORKFLOW_ID,
      name: 'MEKA LinkedIn Jobs · ABCD2345',
      active: false,
      versionId,
      nodes: [{
        id: 'summary-node',
        name: 'Run Summary',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        parameters: {
          mode: 'runOnceForAllItems',
          jsCode: 'return [{ json: {} }];',
        },
        position: [0, 0],
      }],
      connections: {},
      settings: {
        executionOrder: 'v1',
        timezone: 'UTC',
        availableInMCP: true,
      },
    },
  };
}

function passingSummary(overrides = {}) {
  return {
    workflowId: WORKFLOW_ID,
    executionId: EXECUTION_ID,
    status: 'passed',
    fetchedCount: 2,
    newCount: 1,
    appendedCount: 1,
    skippedExisting: 1,
    skippedBatchDuplicates: 0,
    failedSearches: 0,
    failedJobDetails: 0,
    failedCompanies: 0,
    manualLimit: 2,
    manualBudgetUsd: 0.05,
    testPassed: true,
    budgetStopped: false,
    readbackVerified: true,
    previousRowsUnchanged: true,
    allFieldsPresent: true,
    firstSeenAtPresent: true,
    uniqueIds: true,
    manualRun: true,
    companyEnrichmentDisabled: true,
    coverage: 'complete',
    executionMode: 'test',
    ...overrides,
  };
}

function testState() {
  return {
    createAttempted: true,
    status: 'installed-pending-test',
    identity: {
      name: 'MEKA LinkedIn Jobs · ABCD2345',
      nonce: 'ABCD2345',
      description: 'Installer test workflow.',
    },
    workspaceOrigin: WORKSPACE,
    workflowId: WORKFLOW_ID,
    settings: {},
    connectionCheck: {
      apifyCredentialId,
      googleCredentialId,
      evidence: {
        version: 1,
        workspaceOrigin: WORKSPACE,
        workflowId: 'check-workflow-123',
        workflowVersionId: 'check-version-123',
        workflowVersionFingerprint: 'a'.repeat(64),
        executionId: 'check-execution-123',
        apifyCredentialId,
        googleCredentialId,
        apifyStatus: 'ok',
        googleStatus: 'ok',
        checkedAt: new Date(NOW).toISOString(),
      },
    },
  };
}

function successfulClient({
  executeResponse,
  versionIds = [VERSION_ID, VERSION_ID],
  summary = passingSummary(),
} = {}) {
  const calls = [];
  let detailCalls = 0;
  let executionCalls = 0;
  return {
    calls,
    client: {
      async requireTools() {},
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === 'get_workflow_details') {
          const versionId = versionIds[Math.min(detailCalls, versionIds.length - 1)];
          detailCalls += 1;
          return workflowDetails(versionId);
        }
        if (name === 'execute_workflow') {
          return executeResponse ?? {
            executionId: EXECUTION_ID,
            status: 'started',
            responsePolicy: 'execution-response-v1',
          };
        }
        if (name === 'get_workflow_execution') {
          executionCalls += 1;
          if (args.includeData === true) {
            return {
              execution: {
                id: EXECUTION_ID,
                workflowId: WORKFLOW_ID,
                mode: 'manual',
                status: 'success',
                startedAt: '2026-10-27T00:00:00.000Z',
                stoppedAt: '2026-10-27T00:00:02.000Z',
              },
              summary,
              hasPinnedServiceData: false,
              responsePolicy: 'execution-response-v1',
            };
          }
          assert.equal(executionCalls, 1);
          return {
            execution: {
              id: EXECUTION_ID,
              workflowId: WORKFLOW_ID,
              mode: 'manual',
              status: 'success',
              startedAt: '2026-10-27T00:00:00.000Z',
              stoppedAt: '2026-10-27T00:00:02.000Z',
            },
            responsePolicy: 'execution-response-v1',
          };
        }
        throw new Error(`unexpected tool ${name}`);
      },
    },
  };
}

test('strict summary assessment rejects over-limit, incomplete, and inconsistent evidence', () => {
  const testRun = {
    workflowId: WORKFLOW_ID,
    executionId: EXECUTION_ID,
  };
  assert.deepEqual(assessTestSummary(passingSummary(), testRun), {
    outcome: 'passed',
    failureCategory: null,
  });
  assert.deepEqual(assessTestSummary(passingSummary({ manualBudgetUsd: 1 }), testRun), {
    outcome: 'passed',
    failureCategory: null,
  });

  const failures = [
    [passingSummary({ fetchedCount: 11, newCount: 11, skippedExisting: 0 }), 'manual-guard-invalid'],
    [passingSummary({ fetchedCount: 3, newCount: 1, skippedExisting: 2 }), 'manual-guard-invalid'],
    [passingSummary({ manualLimit: 11 }), 'manual-guard-invalid'],
    [passingSummary({ manualBudgetUsd: 1.01 }), 'manual-guard-invalid'],
    [passingSummary({ readbackVerified: undefined }), 'invalid-test-summary'],
    [passingSummary({ failedSearches: undefined }), 'invalid-test-summary'],
    [passingSummary({ coverage: 'partial' }), 'inconsistent-test-summary'],
    [passingSummary({ budgetStopped: true }), 'inconsistent-test-summary'],
    [passingSummary({ appendedCount: 0 }), 'incomplete-pass-evidence'],
    [passingSummary({ previousRowsUnchanged: false }), 'incomplete-pass-evidence'],
    [passingSummary({ workflowId: 'other-workflow' }), 'mismatched-test-summary'],
  ];
  for (const [summary, expected] of failures) {
    assert.equal(
      assessTestSummary(summary, testRun).failureCategory,
      expected,
    );
  }

  assert.equal(
    assessTestSummary(passingSummary({
      status: 'partial',
      failureCategory: 'budget-stopped',
      coverage: 'partial',
      budgetStopped: true,
      testPassed: false,
      readbackVerified: false,
    }), testRun).outcome,
    'needs-attention',
  );
  assert.equal(
    assessTestSummary(passingSummary({
      status: 'no-new-rows',
      newCount: 0,
      appendedCount: 0,
      skippedExisting: 2,
      readbackVerified: false,
      testPassed: false,
    }), testRun).outcome,
    'needs-attention',
  );
});

test('manual test executes once, polls the same ID, verifies the version, and finishes readback', async () => {
  const { client, calls } = successfulClient();
  const state = testState();
  const result = await runManualSmallTest({
    client,
    manifest,
    state,
    confirmed: true,
    nonce: 'ABCD2345',
    now: NOW,
    maxPolls: 1,
    pollIntervalMs: 0,
    wait: async () => {},
  });

  assert.equal(result.outcome, 'passed');
  assert.equal(result.executionId, EXECUTION_ID);
  assert.equal(
    result.executionUrl,
    `${WORKSPACE}/workflow/${WORKFLOW_ID}/executions/${EXECUTION_ID}`,
  );
  assert.equal(result.testPassed, true);
  assert.equal(state.testRun.workflowVersionId, VERSION_ID);
  assert.equal(state.testRun.summary.readbackVerified, true);
  assert.equal(calls.filter(({ name }) => name === 'execute_workflow').length, 1);
  assert.equal(
    calls.filter(({ name, args }) => (
      name === 'get_workflow_execution'
      && args.includeData === true
      && args.nodeNames.length === manifest.nodes.length
    )).length,
    1,
  );
});

test('an ambiguous execute response blocks another paid attempt', async () => {
  const { client, calls } = successfulClient({
    executeResponse: {
      status: 'started',
    },
  });
  const state = testState();
  await assert.rejects(
    runManualSmallTest({
      client,
      manifest,
      state,
      confirmed: true,
      nonce: 'ABCDEFGH',
      now: NOW,
      maxPolls: 1,
      wait: async () => {},
    }),
    { code: 'TEST_EXECUTION_UNKNOWN' },
  );
  assert.equal(state.status, 'unknown');
  assert.equal(state.testRun.outcome, 'unknown');
  assert.equal(state.testRun.executionId, null);

  await assert.rejects(
    runManualSmallTest({
      client,
      manifest,
      state,
      confirmed: true,
      nonce: 'IJKLMNOP',
      now: NOW + 1,
      maxPolls: 1,
      wait: async () => {},
    }),
    { code: 'TEST_EXECUTION_UNKNOWN' },
  );
  assert.equal(calls.filter(({ name }) => name === 'execute_workflow').length, 1);
});

test('a workflow version change after execution is rejected without hiding the linked run', async () => {
  const { client, calls } = successfulClient({
    versionIds: [VERSION_ID, 'main-version-2'],
  });
  const state = testState();
  await assert.rejects(
    runManualSmallTest({
      client,
      manifest,
      state,
      confirmed: true,
      nonce: 'ABCDEFGH',
      now: NOW,
      maxPolls: 1,
      wait: async () => {},
    }),
    (error) => (
      error.code === 'WORKFLOW_VERSION_CHANGED'
      && error.safeDetails.executionUrl
        === `${WORKSPACE}/workflow/${WORKFLOW_ID}/executions/${EXECUTION_ID}`
      && /linked execution/i.test(error.message)
    ),
  );
  assert.equal(calls.filter(({ name }) => name === 'execute_workflow').length, 1);
  assert.equal(state.status, 'failed');
  assert.equal(state.testRun.executionId, EXECUTION_ID);
});
