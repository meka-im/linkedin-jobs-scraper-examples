import {
  EXECUTION_RESPONSE_POLICY_VERSION,
} from './relay-response-policy.js';
import { connectionEvidenceIsCurrent } from './connection-check.js';
import { InstallerError } from './errors.js';
import { verifyInstalledWorkflow } from './verify-install.js';

export const TEST_RUN_SUMMARY_NODE = 'Run Summary';
export const TEST_RUN_POLICY_VERSION = 'manual-small-test-v1';

const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const EXECUTION_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const TEST_NONCE = /^[A-Z0-9]{8}$/u;
const TERMINAL_FAILURES = new Set([
  'error',
  'crashed',
  'canceled',
  'cancelled',
  'failed',
]);
const SUMMARY_NUMBER_FIELDS = Object.freeze([
  'fetchedCount',
  'newCount',
  'appendedCount',
  'skippedExisting',
  'skippedBatchDuplicates',
  'failedSearches',
  'failedJobDetails',
  'failedCompanies',
  'manualLimit',
  'manualBudgetUsd',
]);
const SUMMARY_BOOLEAN_FIELDS = Object.freeze([
  'testPassed',
  'budgetStopped',
  'readbackVerified',
  'previousRowsUnchanged',
  'allFieldsPresent',
  'firstSeenAtPresent',
  'uniqueIds',
  'manualRun',
  'companyEnrichmentDisabled',
]);
const SUMMARY_COUNT_FIELDS = Object.freeze([
  'fetchedCount',
  'newCount',
  'skippedExisting',
  'skippedBatchDuplicates',
  'failedSearches',
  'failedJobDetails',
  'failedCompanies',
]);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function executionRecord(payload) {
  const execution = payload?.execution;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    throw new InstallerError(
      'EXECUTION_READBACK_INVALID',
      'n8n returned no execution metadata.',
    );
  }
  return {
    id: String(execution.id ?? '').trim(),
    workflowId: String(execution.workflowId ?? '').trim(),
    mode: String(execution.mode ?? '').trim(),
    status: String(execution.status ?? '').trim().toLowerCase(),
    stoppedAt: execution.stoppedAt ?? null,
  };
}

function summaryRecord(payload) {
  if (
    payload?.responsePolicy !== EXECUTION_RESPONSE_POLICY_VERSION
    || !payload.summary
    || typeof payload.summary !== 'object'
    || Array.isArray(payload.summary)
  ) {
    return null;
  }
  return payload.summary;
}

function sanitizedSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new InstallerError(
      'TEST_SUMMARY_INVALID',
      'The selected workflow summary is missing or invalid.',
    );
  }
  const output = {};
  for (const field of ['status', 'failureCategory', 'coverage', 'executionMode']) {
    output[field] = typeof summary[field] === 'string'
      ? summary[field]
      : null;
  }
  output.workflowId = typeof summary.workflowId === 'string'
    ? summary.workflowId
    : null;
  output.executionId = typeof summary.executionId === 'string'
    ? summary.executionId
    : null;
  for (const field of SUMMARY_NUMBER_FIELDS) {
    output[field] = Number.isFinite(summary[field])
      ? Number(summary[field])
      : null;
  }
  for (const field of SUMMARY_BOOLEAN_FIELDS) {
    output[field] = typeof summary[field] === 'boolean'
      ? summary[field]
      : null;
  }
  return Object.freeze(output);
}

function workflowContext(verified, workspaceOrigin, workflowName, workflowId) {
  return {
    workspaceOrigin,
    workflowId,
    workflowName,
    workflowVersionId: verified.workflowVersionId,
    workflowVersionFingerprint: verified.workflowVersionFingerprint,
    workflowUrl: `${workspaceOrigin}/workflow/${encodeURIComponent(workflowId)}`,
  };
}

async function ensureCurrentWorkflow({
  client,
  manifest,
  state,
  workspaceOrigin,
  workflowId,
  workflowName,
  phase = 'before-test',
  test = null,
  onStateChange = () => {},
}) {
  const details = await client.callTool('get_workflow_details', { workflowId });
  let verified;
  try {
    verified = await verifyInstalledWorkflow({
      details,
      manifest,
      settings: state.settings ?? null,
      settingsProof: state.settingsProof,
      apifyCredentialId: state.connectionCheck?.apifyCredentialId,
      googleCredentialId: state.connectionCheck?.googleCredentialId,
      workflowId,
      workflowName,
      workspaceOrigin,
    });
  } catch (error) {
    state.status = 'failed';
    if (state.testRun) {
      state.testRun.outcome = 'failed';
      state.testRun.failureCategory = phase === 'after-test'
        ? 'workflow-readback-failed-after-test'
        : 'workflow-readback-failed';
    }
    onStateChange(state);
    if (phase === 'after-test' && test) {
      throw linkedError(
        'TEST_WORKFLOW_READBACK_FAILED',
        'The workflow could not be re-verified after the recorded execution. Its result was not accepted.',
        test,
      );
    }
    throw error;
  }
  if (
    (
      typeof state.workflowVersionId === 'string'
      && state.workflowVersionId !== verified.workflowVersionId
    )
    ||
    typeof state.workflowVersionFingerprint === 'string'
    && state.workflowVersionFingerprint !== verified.workflowVersionFingerprint
  ) {
    state.status = 'failed';
    if (state.testRun) {
      state.testRun.outcome = 'failed';
      state.testRun.failureCategory = phase === 'after-test'
        ? 'workflow-version-changed-after-test'
        : 'workflow-version-changed';
    }
    onStateChange(state);
    if (phase === 'after-test' && test) {
      throw linkedError(
        'WORKFLOW_VERSION_CHANGED',
        'The workflow changed during or after the recorded execution. Its result was not accepted; review the linked execution and current workflow.',
        test,
      );
    }
    throw new InstallerError(
      'WORKFLOW_VERSION_CHANGED',
      'This workflow changed after installation. No paid test was started; review the changed workflow first.',
    );
  }
  state.workflowVersionId = verified.workflowVersionId;
  state.workflowVersionFingerprint = verified.workflowVersionFingerprint;
  return verified;
}

function assertRunGuards(state, confirmed, now) {
  if (confirmed !== true) {
    throw new InstallerError(
      'TEST_CONFIRMATION_REQUIRED',
      'Confirm the manual test limits and possible Apify charge before running it.',
    );
  }
  if (!state.workspaceOrigin || !state.workflowId || !state.identity) {
    throw new InstallerError(
      'TEST_CONTEXT_MISSING',
      'Reconnect to the installed n8n workflow before running a test.',
    );
  }
  const prior = state.testRun;
  if (prior?.executeRequested === true) {
    if (
      prior.executionId
      && ['running', 'unknown', 'execute-requested'].includes(prior.outcome)
    ) {
      return 'resume';
    }
    if (
      !prior.executionId
      && prior.failureCategory !== 'execute-rejected'
    ) {
      throw new InstallerError(
        'TEST_EXECUTION_UNKNOWN',
        'A previous paid test may have started. Inspect the latest n8n execution; the installer will not start another one.',
        {
          safeDetails: {
            workflowUrl: `${state.workspaceOrigin}/workflow/${encodeURIComponent(state.workflowId)}`,
          },
        },
      );
    }
    if (
      prior.outcome !== 'failed'
      && prior.outcome !== 'needs-attention'
      && prior.failureCategory !== 'execute-rejected'
    ) {
      throw new InstallerError(
        'TEST_ALREADY_COMPLETED',
        'This workflow already has a recorded test result. Review it before starting another paid run.',
      );
    }
  }
  if (!connectionEvidenceIsCurrent(state.connectionCheck?.evidence, {
    workspaceOrigin: state.workspaceOrigin,
    apifyCredentialId: state.connectionCheck?.apifyCredentialId,
    googleCredentialId: state.connectionCheck?.googleCredentialId,
    now,
  })) {
    throw new InstallerError(
      'CONNECTION_CHECK_REQUIRED',
      'The account-check snapshot expired or changed. Check both connected accounts again before any paid run.',
    );
  }
  if (!['installed-pending-test', 'failed', 'tested'].includes(state.status)) {
    throw new InstallerError(
      'TEST_STATE_INVALID',
      'The workflow is not in a state that permits a manual test.',
    );
  }
  return 'execute';
}

async function pollTestExecution({
  client,
  workflowId,
  executionId,
  maxPolls,
  pollIntervalMs,
  wait,
}) {
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const payload = await client.callTool('get_workflow_execution', {
      workflowId,
      executionId,
      includeData: false,
    });
    const execution = executionRecord(payload);
    if (execution.id !== executionId || execution.workflowId !== workflowId) {
      throw new InstallerError(
        'EXECUTION_ID_MISMATCH',
        'n8n returned a different execution than the one started by this installer.',
      );
    }
    if (TERMINAL_FAILURES.has(execution.status)) {
      return { execution, outcome: 'failed' };
    }
    if (execution.status === 'success' && execution.stoppedAt) {
      return { execution, outcome: 'success' };
    }
    if (attempt + 1 < maxPolls) await wait(pollIntervalMs);
  }
  return null;
}

function allRequiredSummaryFieldsPresent(summary) {
  return (
    typeof summary.status === 'string'
    && typeof summary.workflowId === 'string'
    && typeof summary.executionId === 'string'
    && SUMMARY_COUNT_FIELDS.every((field) => (
      Number.isInteger(summary[field]) && summary[field] >= 0
    ))
    && Number.isInteger(summary.appendedCount)
    && Number.isInteger(summary.manualLimit)
    && Number.isFinite(summary.manualBudgetUsd)
    && SUMMARY_BOOLEAN_FIELDS.every((field) => (
      typeof summary[field] === 'boolean'
    ))
    && ['complete', 'partial'].includes(summary.coverage)
    && ['test', 'production'].includes(summary.executionMode)
  );
}

export function assessTestSummary(summary, test) {
  if (!allRequiredSummaryFieldsPresent(summary)) {
    return {
      outcome: 'failed',
      failureCategory: 'invalid-test-summary',
    };
  }
  if (
    summary.workflowId !== test.workflowId
    || summary.executionId !== test.executionId
  ) {
    return {
      outcome: 'failed',
      failureCategory: 'mismatched-test-summary',
    };
  }
  const failureCounts = (
    summary.failedSearches
    + summary.failedJobDetails
    + summary.failedCompanies
  );
  if (
    summary.fetchedCount !== (
      summary.newCount
      + summary.skippedExisting
      + summary.skippedBatchDuplicates
    )
    || (
      summary.coverage === 'complete'
        ? (failureCounts !== 0 || summary.budgetStopped)
        : (failureCounts === 0 && !summary.budgetStopped)
    )
  ) {
    return {
      outcome: 'failed',
      failureCategory: 'inconsistent-test-summary',
    };
  }
  const manualGuardsValid = (
    summary.executionMode === 'test'
    && summary.manualRun === true
    && summary.companyEnrichmentDisabled === true
    && summary.manualLimit >= 1
    && summary.manualLimit <= 10
    && summary.manualBudgetUsd > 0
    && summary.manualBudgetUsd <= 1
  );
  if (!manualGuardsValid) {
    return {
      outcome: 'failed',
      failureCategory: 'manual-guard-invalid',
    };
  }
  if (
    summary.fetchedCount > summary.manualLimit
    || summary.fetchedCount > 10
    || summary.manualLimit > 10
  ) {
    return {
      outcome: 'failed',
      failureCategory: 'manual-guard-invalid',
    };
  }
  if (summary.status === 'passed') {
    const passed = (
      summary.testPassed === true
      && summary.coverage === 'complete'
      && summary.budgetStopped === false
      && failureCounts === 0
      && summary.fetchedCount >= summary.newCount
      && summary.newCount > 0
      && summary.appendedCount === summary.newCount
      && summary.readbackVerified === true
      && summary.previousRowsUnchanged === true
      && summary.allFieldsPresent === true
      && summary.firstSeenAtPresent === true
      && summary.uniqueIds === true
    );
    return {
      outcome: passed ? 'passed' : 'failed',
      failureCategory: passed ? null : 'incomplete-pass-evidence',
    };
  }
  if (summary.status === 'partial') {
    if (summary.appendedCount < 0) {
      return {
        outcome: 'failed',
        failureCategory: 'invalid-test-summary',
      };
    }
    return {
      outcome: 'needs-attention',
      failureCategory: summary.failureCategory ?? summary.status,
    };
  }
  if (summary.status === 'no-new-rows') {
    if (
      summary.newCount !== 0
      || summary.appendedCount !== 0
      || summary.readbackVerified !== false
    ) {
      return {
        outcome: 'failed',
        failureCategory: 'invalid-test-summary',
      };
    }
    return {
      outcome: 'needs-attention',
      failureCategory: summary.failureCategory ?? summary.status,
    };
  }
  if (summary.status === 'write-unverified') {
    return {
      outcome: 'needs-attention',
      failureCategory: summary.failureCategory ?? summary.status,
    };
  }
  return {
    outcome: 'failed',
    failureCategory: summary.failureCategory ?? 'unexpected-test-status',
  };
}

function executionUrl(test) {
  if (
    !test?.workspaceOrigin
    || !WORKFLOW_ID.test(test.workflowId ?? '')
    || !EXECUTION_ID.test(test.executionId ?? '')
  ) {
    return null;
  }
  return `${test.workspaceOrigin}/workflow/${encodeURIComponent(test.workflowId)}/executions/${encodeURIComponent(test.executionId)}`;
}

function linkedError(code, message, test, extra = {}) {
  return new InstallerError(code, message, {
    safeDetails: {
      workflowUrl: test.workflowUrl,
      executionUrl: executionUrl(test),
      ...extra,
    },
  });
}

async function finishTestExecution({
  client,
  manifest,
  state,
  maxPolls,
  pollIntervalMs,
  wait,
  now,
  onStateChange,
}) {
  const test = state.testRun;
  state.status = 'running';
  test.outcome = 'running';
  onStateChange(state);
  const polled = await pollTestExecution({
    client,
    workflowId: test.workflowId,
    executionId: test.executionId,
    maxPolls,
    pollIntervalMs,
    wait,
  });
  if (!polled) {
    state.status = 'unknown';
    test.outcome = 'unknown';
    test.lastCheckedAt = new Date(now).toISOString();
    onStateChange(state);
    throw linkedError(
      'TEST_EXECUTION_UNKNOWN',
      'The manual test has not reached a terminal state. Check this same execution later; it will not be restarted.',
      test,
    );
  }
  if (polled.outcome !== 'success') {
    state.status = 'failed';
    test.outcome = 'failed';
    test.failureCategory = 'execution-failed';
    test.finishedAt = new Date(now).toISOString();
    onStateChange(state);
    throw linkedError(
      'TEST_EXECUTION_FAILED',
      'The manual test failed. Review the linked n8n execution and its failed node; another paid run is not started automatically.',
      test,
    );
  }

  const verifiedAfterRun = await ensureCurrentWorkflow({
    client,
    manifest,
    state,
    workspaceOrigin: test.workspaceOrigin,
    workflowId: test.workflowId,
    workflowName: test.workflowName,
    phase: 'after-test',
    test,
    onStateChange,
  });
  if (
    verifiedAfterRun.workflowVersionId
      !== test.workflowVersionId
    ||
    verifiedAfterRun.workflowVersionFingerprint
    !== test.workflowVersionFingerprint
  ) {
    state.status = 'failed';
    test.outcome = 'failed';
    test.failureCategory = 'workflow-version-changed-during-test';
    onStateChange(state);
    throw linkedError(
      'WORKFLOW_VERSION_CHANGED',
      'The workflow changed during the paid execution. Its result was not accepted.',
      test,
    );
  }

  let finalPayload;
  try {
    finalPayload = await client.callTool('get_workflow_execution', {
      workflowId: test.workflowId,
      executionId: test.executionId,
      includeData: true,
      nodeNames: manifest.nodes.map((node) => node.name),
      truncateData: 1,
    });
  } catch {
    state.status = 'unknown';
    test.outcome = 'unknown';
    test.failureCategory = 'execution-evidence-unavailable';
    test.lastCheckedAt = new Date(now).toISOString();
    onStateChange(state);
    throw linkedError(
      'TEST_EVIDENCE_UNKNOWN',
      'The paid execution finished, but its sanitized summary could not be read. Retry reading this same execution; do not start another run.',
      test,
    );
  }
  const finalExecution = executionRecord(finalPayload);
  if (
    finalExecution.id !== test.executionId
    || finalExecution.workflowId !== test.workflowId
    || finalExecution.status !== 'success'
    || !finalExecution.stoppedAt
    || finalPayload?.hasPinnedServiceData !== false
  ) {
    state.status = 'failed';
    test.outcome = 'failed';
    test.failureCategory = finalPayload?.hasPinnedServiceData === 'unknown'
      ? 'pin-evidence-unknown'
      : 'execution-evidence-invalid';
    test.finishedAt = new Date(now).toISOString();
    onStateChange(state);
    throw linkedError(
      'TEST_PINNED_OR_MISMATCHED',
      'The execution result was pinned, incomplete, or did not match this run. No successful result was accepted.',
      test,
    );
  }

  let summary;
  try {
    summary = sanitizedSummary(summaryRecord(finalPayload));
  } catch {
    state.status = 'failed';
    test.outcome = 'failed';
    test.failureCategory = 'summary-missing';
    test.finishedAt = new Date(now).toISOString();
    onStateChange(state);
    throw linkedError(
      'TEST_SUMMARY_INVALID',
      'The paid execution did not return the reviewed sanitized summary.',
      test,
    );
  }
  const assessed = assessTestSummary(summary, test);
  state.status = 'tested';
  test.outcome = assessed.outcome;
  test.failureCategory = assessed.failureCategory;
  test.finishedAt = new Date(now).toISOString();
  test.summary = summary;
  test.testPassed = assessed.outcome === 'passed';
  test.inactiveAtCheck = verifiedAfterRun.active === false;
  test.scheduleActive = false;
  onStateChange(state);
  return Object.freeze({
    status: state.status,
    testPassed: test.testPassed,
    outcome: test.outcome,
    workflowId: test.workflowId,
    workflowVersionId: verifiedAfterRun.workflowVersionId,
    workflowVersionFingerprint: test.workflowVersionFingerprint,
    executionId: test.executionId,
    checkedAt: test.finishedAt,
    inactiveAtCheck: test.inactiveAtCheck,
    summary,
    workflowUrl: test.workflowUrl,
    executionUrl: executionUrl(test),
  });
}

export async function resumeManualTest({
  client,
  manifest,
  state = {},
  onStateChange = () => {},
  now = Date.now(),
  wait = sleep,
  pollIntervalMs = 2_000,
  maxPolls = 60,
}) {
  const test = state.testRun;
  if (
    !test?.executeRequested
    || !EXECUTION_ID.test(test.executionId ?? '')
    || !WORKFLOW_ID.test(test.workflowId ?? '')
    || !WORKFLOW_ID.test(test.workflowVersionId ?? '')
    || !manifest
  ) {
    throw new InstallerError(
      'TEST_RESUME_UNAVAILABLE',
      'No recorded manual-test execution can be resumed.',
    );
  }
  client.requireTools(['get_workflow_details', 'get_workflow_execution']);
  return finishTestExecution({
    client,
    manifest,
    state,
    maxPolls,
    pollIntervalMs,
    wait,
    now,
    onStateChange,
  });
}

export async function runManualSmallTest({
  client,
  manifest,
  state = {},
  confirmed,
  nonce,
  onStateChange = () => {},
  now = Date.now(),
  wait = sleep,
  pollIntervalMs = 2_000,
  maxPolls = 60,
}) {
  if (
    !client
    || typeof client.callTool !== 'function'
    || typeof client.requireTools !== 'function'
    || !manifest
  ) {
    throw new InstallerError(
      'MCP_CLIENT_INVALID',
      'The MCP client or reviewed workflow manifest is unavailable.',
    );
  }
  if (typeof nonce !== 'string' || !TEST_NONCE.test(nonce)) {
    throw new InstallerError(
      'TEST_NONCE_INVALID',
      'The manual-test marker is invalid.',
    );
  }
  const action = assertRunGuards(state, confirmed, now);
  if (action === 'resume') {
    return resumeManualTest({
      client,
      manifest,
      state,
      onStateChange,
      now,
      wait,
      pollIntervalMs,
      maxPolls,
    });
  }

  client.requireTools([
    'get_workflow_details',
    'execute_workflow',
    'get_workflow_execution',
  ]);
  const verified = await ensureCurrentWorkflow({
    client,
    manifest,
    state,
    workspaceOrigin: state.workspaceOrigin,
    workflowId: state.workflowId,
    workflowName: state.identity.name,
    phase: 'before-test',
    onStateChange,
  });
  const context = workflowContext(
    verified,
    state.workspaceOrigin,
    state.identity.name,
    state.workflowId,
  );
  state.workflowVersionId = verified.workflowVersionId;
  state.workflowVersionFingerprint = verified.workflowVersionFingerprint;
  state.status = 'running';
  state.testRun = {
    version: 1,
    policy: TEST_RUN_POLICY_VERSION,
    nonce,
    intentId: `test-${nonce}-${now}`,
    executeRequested: true,
    executionId: null,
    workflowId: state.workflowId,
    workflowVersionId: verified.workflowVersionId,
    workflowName: state.identity.name,
    workspaceOrigin: state.workspaceOrigin,
    workflowVersionFingerprint: verified.workflowVersionFingerprint,
    workflowUrl: context.workflowUrl,
    startedAt: new Date(now).toISOString(),
    outcome: 'execute-requested',
    maxJobs: 10,
    maxBudgetUsd: 1,
    companyEnrichment: false,
    scheduleActive: false,
  };
  onStateChange(state);

  let executed;
  try {
    executed = await client.callTool('execute_workflow', {
      workflowId: state.workflowId,
      executionMode: 'manual',
      triggerNodeName: 'Manual Trigger',
    });
  } catch {
    state.status = 'unknown';
    state.testRun.outcome = 'unknown';
    state.testRun.failureCategory = 'execute-outcome-unknown';
    onStateChange(state);
    throw new InstallerError(
      'TEST_EXECUTION_UNKNOWN',
      'n8n did not return a reliable execution result. Do not click again; inspect the workflow’s latest execution in n8n.',
      { safeDetails: { workflowUrl: context.workflowUrl } },
    );
  }
  if (
    executed?.responsePolicy === EXECUTION_RESPONSE_POLICY_VERSION
    && executed?.status === 'error'
    && executed?.executionId === null
  ) {
    state.status = 'failed';
    state.testRun.outcome = 'failed';
    state.testRun.failureCategory = 'execute-rejected';
    onStateChange(state);
    throw new InstallerError(
      'TEST_EXECUTION_REJECTED',
      'n8n rejected the explicit manual test. No test was retried. Review the workflow and MCP scopes before a new confirmed run.',
      { safeDetails: { workflowUrl: context.workflowUrl } },
    );
  }
  if (
    executed?.responsePolicy !== EXECUTION_RESPONSE_POLICY_VERSION
    || executed?.status !== 'started'
    || !EXECUTION_ID.test(executed?.executionId ?? '')
  ) {
    state.status = 'unknown';
    state.testRun.outcome = 'unknown';
    state.testRun.failureCategory = 'execute-outcome-unknown';
    onStateChange(state);
    throw new InstallerError(
      'TEST_EXECUTION_UNKNOWN',
      'n8n did not return a reliably started execution result. Do not click again; inspect the workflow’s latest execution in n8n.',
      { safeDetails: { workflowUrl: context.workflowUrl } },
    );
  }
  state.testRun.executionId = executed.executionId;
  state.testRun.outcome = 'running';
  onStateChange(state);
  return finishTestExecution({
    client,
    manifest,
    state,
    maxPolls,
    pollIntervalMs,
    wait,
    now,
    onStateChange,
  });
}
