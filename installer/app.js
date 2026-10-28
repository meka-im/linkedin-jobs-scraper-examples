import {
  beginOAuthConnection,
  finishOAuthConnection,
} from './lib/oauth.js';
import {
  beginWorkspaceConnection,
  claimConnectionCheck,
  claimInstallSubmit,
  claimTestSubmit,
  releaseConnectionCheck,
  releaseInstallSubmit,
  releaseTestSubmit,
} from './lib/app-controller.js';
import {
  OAUTH_SESSION_KEY,
  createSessionStorageAdapter,
} from './lib/oauth-session.js';
import { McpClient } from './lib/mcp-client.js';
import {
  APIFY_CREDENTIAL_TYPE,
  GOOGLE_CREDENTIAL_TYPE,
  credentialChoices,
  listCredentialCandidates,
} from './lib/credentials.js';
import {
  createDirectMcpTransport,
  createSameOriginRelayTransport,
} from './lib/http-transport.js';
import {
  REQUIRED_MCP_TOOLS,
  installWorkflow,
  installationNonce,
  recoverUnknownInstallation,
} from './lib/install.js';
import {
  connectionCheckRequiresHelperReset,
  connectionEvidenceIsCurrent,
  invalidateConnectionCheck,
  resetTerminalConnectionCheckAttempt,
  runConnectionCheck,
} from './lib/connection-check.js';
import {
  resumeManualTest,
  runManualSmallTest,
} from './lib/test-run.js';
import {
  loadInstallRecovery,
  saveInstallRecovery,
} from './lib/install-recovery.js';
import { publicErrorMessage } from './lib/errors.js';
import { WORKFLOW_TEMPLATE } from './generated/workflow-template.js';
import { WORKFLOW_MANIFEST } from './generated/workflow-manifest.js';

const session = createSessionStorageAdapter(sessionStorage);
const memory = {
  accessToken: null,
  workspace: null,
  client: null,
  transport: null,
  apifyCredentials: [],
  googleCredentials: [],
  installState: {},
  inflightRecovery: false,
};

const byId = (id) => document.getElementById(id);
const elements = {
  workspacePanel: byId('workspace-panel'),
  setupPanel: byId('setup-panel'),
  recoveryPanel: byId('recovery-panel'),
  successPanel: byId('success-panel'),
  successMark: byId('success-mark'),
  statusPanel: byId('status-panel'),
  statusTitle: byId('status-title'),
  statusMessage: byId('status-message'),
  statusActions: byId('status-actions'),
  workspaceForm: byId('workspace-form'),
  workspaceUrl: byId('workspace-url'),
  connectButton: byId('connect-button'),
  mcpSettingsLink: byId('mcp-settings-link'),
  workspaceSummary: byId('workspace-summary'),
  apifyCredential: byId('apify-credential'),
  googleCredential: byId('google-credential'),
  credentialHelp: byId('credential-help'),
  refreshCredentials: byId('refresh-credentials'),
  connectionCheckButton: byId('connection-check-button'),
  connectionStatus: byId('connection-status'),
  installForm: byId('install-form'),
  installButton: byId('install-button'),
  recoveryId: byId('recovery-id'),
  recoveryButton: byId('recovery-button'),
  openExisting: byId('open-existing'),
  successTitle: byId('success-title'),
  successMessage: byId('success-message'),
  successEyebrow: byId('success-eyebrow'),
  testStatus: byId('test-status'),
  testConsentRow: byId('test-consent-row'),
  testConsent: byId('test-consent'),
  testButton: byId('test-button'),
  testExecution: byId('test-execution'),
  openWorkflow: byId('open-workflow'),
};

function setStep(active) {
  const order = ['workspace', 'connect', 'search', 'install'];
  const activeIndex = order.indexOf(active);
  order.forEach((name, index) => {
    const node = byId(`step-${name}`);
    node.classList.toggle('active', index === activeIndex);
    node.classList.toggle('done', activeIndex >= 0 && index < activeIndex);
  });
}

function clearStatus() {
  elements.statusPanel.hidden = true;
  elements.statusPanel.classList.remove('error');
  elements.statusActions.replaceChildren();
}

function showStatus(title, message, { error = false, actions = [] } = {}) {
  elements.statusPanel.hidden = false;
  elements.statusPanel.classList.toggle('error', error);
  elements.statusTitle.textContent = title;
  elements.statusMessage.textContent = message;
  elements.statusActions.replaceChildren();
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button quiet';
    button.textContent = action.label;
    button.addEventListener('click', action.onClick);
    elements.statusActions.append(button);
  }
  elements.statusPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showError(error) {
  showStatus('Could not complete this step', publicErrorMessage(error), { error: true });
  if (error?.safeDetails?.settingsMcpUrl) {
    const link = document.createElement('a');
    link.className = 'button quiet';
    link.href = error.safeDetails.settingsMcpUrl;
    link.rel = 'noreferrer';
    link.textContent = 'Open Settings → MCP';
    elements.statusActions.append(link);
  }
  for (const [url, label] of [
    [error?.safeDetails?.apifyCredentialUrl, 'Reconnect Apify'],
    [error?.safeDetails?.googleCredentialUrl, 'Reconnect Google'],
    [error?.safeDetails?.workflowUrl, 'Open check workflow'],
    [error?.safeDetails?.executionUrl, 'Open n8n execution'],
  ]) {
    if (typeof url !== 'string' || !url) continue;
    const link = document.createElement('a');
    link.className = 'button quiet';
    link.href = url;
    link.rel = 'noreferrer';
    link.target = '_blank';
    link.textContent = label;
    elements.statusActions.append(link);
  }
}

function setBusy(button, busy, busyText = 'Working…') {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText ?? button.textContent;
    button.disabled = false;
  }
}

function callbackLocation() {
  const callback = location.search || location.hash ? location.href : null;
  if (location.search || location.hash) {
    history.replaceState(null, '', location.pathname);
  }
  return callback;
}

async function relayAvailable() {
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.relay === true
      && (body?.loopbackOnly === true || body?.publicRelay === true);
  } catch {
    return false;
  }
}

async function createClient(accessToken, workspace) {
  const transport = await relayAvailable()
    ? createSameOriginRelayTransport({ workspace, accessToken })
    : createDirectMcpTransport({ workspace, accessToken });
  const client = new McpClient(transport);
  client.workspaceOrigin = workspace.origin;
  await client.connect();
  await client.listTools();
  client.requireTools(REQUIRED_MCP_TOOLS);
  return client;
}

async function activateConnectedSession(workspace, accessToken) {
  memory.workspace = workspace;
  memory.accessToken = accessToken;
  memory.client = await createClient(accessToken, workspace);
  memory.transport = memory.client.transport;
  elements.workspacePanel.hidden = true;
  elements.setupPanel.hidden = false;
  elements.workspaceSummary.textContent = workspace.origin;
  if (memory.installState.createAttempted) {
    if (memory.installState.legacyReviewRequired) {
      elements.setupPanel.hidden = true;
      showLegacyRecovery();
    } else if (memory.installState.workspaceOrigin !== workspace.origin) {
      elements.setupPanel.hidden = true;
      setStep('install');
      showStatus(
        'Another workspace has an interrupted installation',
        'Connect the workspace named by the saved install marker before checking it. No workflow was created.',
        { error: true },
      );
    } else if (
      memory.installState.workflowId
      && !['unknown', 'created-unverified'].includes(memory.installState.status)
    ) {
      showTestPanel();
    } else {
      elements.setupPanel.hidden = true;
      showRecovery(
        'Reconnect completed. Check the existing workflow before starting any new installation.',
      );
    }
  } else {
    setStep('connect');
    await refreshCredentials();
    renderConnectionStatus();
    clearStatus();
  }
}

function credentialOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function fillCredentialSelect(select, candidates, label) {
  select.replaceChildren();
  if (candidates.length === 0) {
    select.append(credentialOption('', `No ${label} credential found`));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  if (candidates.length > 1) {
    select.append(credentialOption('', `Choose a ${label} credential`));
  }
  for (const credential of candidates) {
    const tags = [credential.isManaged ? 'managed' : null, credential.isGlobal ? 'global' : null]
      .filter(Boolean);
    select.append(credentialOption(
      credential.id,
      `${credential.name}${tags.length ? ` (${tags.join(', ')})` : ''}`,
    ));
  }
}

function credentialInstructions() {
  const lines = [];
  if (memory.apifyCredentials.length === 0) {
    lines.push(
      'Apify credential missing: connect the official @apify/n8n-nodes-apify 0.8.1 OAuth credential in n8n. '
      + 'If the node package is unavailable, install it from n8n Community Nodes, then refresh.',
    );
  }
  if (memory.googleCredentials.length === 0) {
    lines.push('Google credential missing: connect a Google Sheets OAuth2 credential in n8n, then refresh.');
  }
  lines.push(
    'HTTP request domains must be exact: api.apify.com for Apify; www.googleapis.com and sheets.googleapis.com for Google. '
    + 'Specific Domains is required. Do not select All. MCP cannot inspect or change credential secrets or domain permissions.',
  );
  if (memory.client?.hasTool('install_community_node')) {
    lines.push(
      'This session can access n8n community-node installation, but the installer does not silently install packages. '
      + 'Install the official Apify package yourself, review its registry source, then refresh.',
    );
  }
  elements.credentialHelp.textContent = lines.join(' ');
}

async function refreshCredentials({ invalidate = false } = {}) {
  if (!memory.client) return;
  setBusy(elements.refreshCredentials, true, 'Refreshing…');
  try {
    [memory.apifyCredentials, memory.googleCredentials] = await Promise.all([
      listCredentialCandidates(memory.client, APIFY_CREDENTIAL_TYPE),
      listCredentialCandidates(memory.client, GOOGLE_CREDENTIAL_TYPE),
    ]);
    fillCredentialSelect(elements.apifyCredential, credentialChoices(
      memory.apifyCredentials,
      APIFY_CREDENTIAL_TYPE,
    ), 'Apify OAuth');
    fillCredentialSelect(elements.googleCredential, credentialChoices(
      memory.googleCredentials,
      GOOGLE_CREDENTIAL_TYPE,
    ), 'Google Sheets OAuth');
    const check = memory.installState.connectionCheck;
    if (
      check?.apifyCredentialId
      && memory.apifyCredentials.some(({ id }) => id === check.apifyCredentialId)
    ) {
      elements.apifyCredential.value = check.apifyCredentialId;
    }
    if (
      check?.googleCredentialId
      && memory.googleCredentials.some(({ id }) => id === check.googleCredentialId)
    ) {
      elements.googleCredential.value = check.googleCredentialId;
    }
    if (
      invalidate
      || (
        check?.evidence
        && (
          check.apifyCredentialId !== elements.apifyCredential.value
          || check.googleCredentialId !== elements.googleCredential.value
        )
      )
    ) {
      invalidateConnectionCheck(
        memory.installState,
        invalidate ? 'credentials-refreshed' : 'credential-selection-changed',
      );
      persistInstallState(memory.installState);
    }
    updateInstallAvailability();
    renderConnectionStatus();
    credentialInstructions();
    persistInstallState(memory.installState);
  } finally {
    setBusy(elements.refreshCredentials, false);
  }
}

function credentialLink(credentialId, label) {
  if (!memory.workspace || !credentialId) return null;
  const link = document.createElement('a');
  link.className = 'button quiet';
  link.href = `${memory.workspace.origin}/home/credentials/${encodeURIComponent(credentialId)}`;
  link.target = '_blank';
  link.rel = 'noreferrer';
  link.textContent = label;
  return link;
}

function renderConnectionStatus() {
  elements.connectionStatus.replaceChildren();
  const check = memory.installState.connectionCheck;
  if (!check) {
    elements.connectionStatus.textContent =
      'Apify: not checked. Google read access: not checked.';
    updateInstallAvailability();
    return;
  }
  const apify = document.createElement('p');
  const serviceState = (status) => {
    switch (status) {
      case 'ok': return 'reachable';
      case 'rate-limited': return 'temporarily rate limited';
      case 'authorization-failed': return 'sign-in or permission failed';
      case 'not-connected': return 'not connected';
      case 'temporary-unavailable': return 'temporarily unavailable';
      case 'blocked': return 'could not verify';
      case 'invalid-response': return 'unexpected response';
      default: return 'not checked';
    }
  };
  const serviceNextStep = (status) => {
    switch (status) {
      case 'ok': return null;
      case 'rate-limited':
        return 'The service applied a temporary rate limit. Wait briefly, then check again.';
      case 'authorization-failed':
        return 'Reconnect this credential, then check both connections again.';
      case 'not-connected':
        return 'Finish the sign-in for this credential, then check both connections again.';
      case 'temporary-unavailable':
        return 'The service was temporarily unavailable. Try the check again later.';
      case 'blocked':
        return 'The check could not verify this account. Check again; if it repeats, open the helper workflow.';
      case 'invalid-response':
        return 'The helper returned an unexpected result. Check again; if it repeats, open the helper workflow.';
      default: return null;
    }
  };
  const reconnectRequired = (status) => (
    status === 'authorization-failed' || status === 'not-connected'
  );
  apify.textContent = `Apify account/API: ${serviceState(check.apifyStatus)}.`;
  const google = document.createElement('p');
  google.textContent = `Google read access: ${serviceState(check.googleStatus)}.`;
  elements.connectionStatus.append(apify, google);
  if (reconnectRequired(check.apifyStatus)) {
    const link = credentialLink(check.apifyCredentialId, 'Reconnect Apify');
    if (link) elements.connectionStatus.append(link);
  }
  if (serviceNextStep(check.apifyStatus)) {
    const next = document.createElement('p');
    next.className = 'fine-print';
    next.textContent = `Apify: ${serviceNextStep(check.apifyStatus)}`;
    elements.connectionStatus.append(next);
  }
  if (reconnectRequired(check.googleStatus)) {
    const link = credentialLink(check.googleCredentialId, 'Reconnect Google');
    if (link) elements.connectionStatus.append(link);
  }
  if (serviceNextStep(check.googleStatus)) {
    const next = document.createElement('p');
    next.className = 'fine-print';
    next.textContent = `Google: ${serviceNextStep(check.googleStatus)}`;
    elements.connectionStatus.append(next);
  }
  const needsHelperReset = connectionCheckRequiresHelperReset(check);
  if (needsHelperReset) {
    const notice = document.createElement('p');
    notice.className = 'fine-print';
    notice.textContent =
      'This completed check used an older helper. Its workflow and execution remain available for review.';
    elements.connectionStatus.append(notice);
    if (check.workflowId) {
      const oldWorkflow = document.createElement('a');
      oldWorkflow.className = 'button quiet';
      oldWorkflow.href =
        `${memory.workspace.origin}/workflow/${encodeURIComponent(check.workflowId)}`;
      oldWorkflow.target = '_blank';
      oldWorkflow.rel = 'noreferrer';
      oldWorkflow.textContent = 'Open old helper';
      elements.connectionStatus.append(oldWorkflow);
    }
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'button quiet';
    reset.textContent = 'Reset completed account check';
    reset.addEventListener('click', resetCompletedConnectionCheck);
    elements.connectionStatus.append(reset);
  }
  if (check.resetAttempt) {
    const retained = document.createElement('p');
    retained.className = 'fine-print';
    retained.textContent = 'Previous completed helper retained for review.';
    if (check.resetAttempt.previousWorkflowId) {
      const previous = document.createElement('a');
      previous.href =
        `${memory.workspace.origin}/workflow/${encodeURIComponent(check.resetAttempt.previousWorkflowId)}`;
      previous.target = '_blank';
      previous.rel = 'noreferrer';
      previous.textContent = ' Open helper';
      retained.append(previous);
    }
    if (
      check.resetAttempt.previousExecutionId
      && check.resetAttempt.previousWorkflowId
      && memory.workspace?.origin
    ) {
      const previousExecution = document.createElement('a');
      previousExecution.href =
        `${memory.workspace.origin}/workflow/${encodeURIComponent(check.resetAttempt.previousWorkflowId)}/executions/${encodeURIComponent(check.resetAttempt.previousExecutionId)}`;
      previousExecution.target = '_blank';
      previousExecution.rel = 'noreferrer';
      previousExecution.textContent = ' or open execution';
      retained.append(previousExecution);
    }
    elements.connectionStatus.append(retained);
  }
  if (check.evidence?.checkedAt) {
    const snapshot = document.createElement('p');
    snapshot.className = 'fine-print';
    snapshot.textContent = `Snapshot checked ${check.evidence.checkedAt}. It can expire or change in n8n.`;
    elements.connectionStatus.append(snapshot);
  }
  elements.connectionCheckButton.disabled = needsHelperReset;
  updateInstallAvailability();
}

function resetCompletedConnectionCheck() {
  try {
    resetTerminalConnectionCheckAttempt(memory.installState);
    persistInstallState(memory.installState);
    renderConnectionStatus();
    showStatus(
      'Completed account check reset',
      'The old helper workflow and execution remain linked. Check both connections to create a fresh helper.',
    );
  } catch (error) {
    showError(error);
  }
}

function updateInstallAvailability() {
  const workspaceOrigin = memory.workspace?.origin ?? '';
  const check = memory.installState.connectionCheck;
  const current = workspaceOrigin && check && connectionEvidenceIsCurrent(
    check.evidence,
    {
      workspaceOrigin,
      apifyCredentialId: elements.apifyCredential.value,
      googleCredentialId: elements.googleCredential.value,
    },
  );
  elements.installButton.disabled = !current || Boolean(memory.installState.inflightInstall);
}

function formSettings() {
  return {
    keywords: byId('keywords').value,
    location: byId('location').value,
    datePosted: byId('date-posted').value,
    limit: Number(byId('limit').value),
    budgetUsd: Number(byId('budget').value),
    scrapeCompany: byId('scrape-company').checked,
    spreadsheetTitle: byId('spreadsheet-title').value,
  };
}

async function checkConnections() {
  if (!memory.client || !memory.workspace) return;
  const claim = claimConnectionCheck(memory.installState);
  if (!claim.allowed) {
    if (claim.reason === 'execution-unknown') {
      showRecovery(
        'The account-check outcome is unknown. Open the check workflow and inspect its latest execution; do not start another check.',
      );
    }
    return;
  }
  setBusy(elements.connectionCheckButton, true, 'Checking both accounts…');
  clearStatus();
  try {
    await runConnectionCheck({
      client: memory.client,
      workspaceOrigin: memory.workspace.origin,
      apifyCredentialId: elements.apifyCredential.value,
      googleCredentialId: elements.googleCredential.value,
      nonce: installationNonce(),
      state: memory.installState,
      onStateChange: persistInstallState,
    });
    renderConnectionStatus();
    showStatus(
      'Both connections are checked',
      'Apify account/API and Google read access responded. Sheet write access will be verified only by the later manual test.',
    );
  } catch (error) {
    renderConnectionStatus();
    showError(error);
  } finally {
    releaseConnectionCheck(memory.installState);
    setBusy(elements.connectionCheckButton, false);
    updateInstallAvailability();
  }
}

function showRecovery(message) {
  elements.installForm.hidden = true;
  elements.recoveryPanel.hidden = false;
  elements.recoveryButton.hidden = false;
  elements.recoveryId.disabled = false;
  elements.recoveryId.value = memory.installState.workflowId ?? '';
  const { workspaceOrigin, workflowId } = memory.installState;
  if (workspaceOrigin && workflowId) {
    elements.openExisting.href = `${workspaceOrigin}/workflow/${encodeURIComponent(workflowId)}`;
    elements.openExisting.hidden = false;
  } else {
    elements.openExisting.removeAttribute('href');
    elements.openExisting.hidden = true;
  }
  setStep('install');
  elements.successPanel.hidden = true;
  showStatus('Installation state unknown', message, { error: true });
}

function showLegacyRecovery() {
  elements.installForm.hidden = true;
  elements.recoveryPanel.hidden = false;
  elements.recoveryButton.hidden = true;
  elements.recoveryId.disabled = true;
  elements.recoveryId.value = memory.installState.workflowId ?? '';
  const { workspaceOrigin, workflowId } = memory.installState;
  if (workspaceOrigin && workflowId) {
    elements.openExisting.href = `${workspaceOrigin}/workflow/${encodeURIComponent(workflowId)}`;
    elements.openExisting.hidden = false;
  } else {
    elements.openExisting.removeAttribute('href');
    elements.openExisting.hidden = true;
  }
  setStep('install');
  elements.successPanel.hidden = true;
  showStatus(
    'Earlier installation needs manual review',
    'A saved request from the previous 41-node installer cannot be checked against the reviewed 42-node workflow. Inspect the named workflow in n8n yourself. This installer will not create another workflow automatically.',
    { error: true },
  );
}

function persistInstallState(state) {
  saveInstallRecovery(session, state);
}

function testWindowOpen(result) {
  return Boolean(result?.workflowId || result?.openUrl || result?.url);
}

function showTestPanel(result = {}) {
  elements.recoveryPanel.hidden = true;
  elements.setupPanel.hidden = true;
  elements.successPanel.hidden = false;
  const workflowId = result.workflowId ?? memory.installState.workflowId;
  const workspaceOrigin = memory.workspace?.origin ?? memory.installState.workspaceOrigin;
  const workflowUrl = result.url
    ?? result.openUrl
    ?? (workspaceOrigin && workflowId
      ? `${workspaceOrigin}/workflow/${encodeURIComponent(workflowId)}`
      : null);
  const test = memory.installState.testRun;
  const testOutcome = test?.outcome ?? 'pending';
  const checkedAt = test?.finishedAt ?? memory.installState.connectionCheck?.evidence?.checkedAt;
  elements.successPanel.classList.remove('passed', 'attention', 'failed');
  if (testOutcome === 'passed') {
    elements.successPanel.classList.add('passed');
    elements.successMark.textContent = '✓';
    elements.successEyebrow.textContent = 'Test passed';
    elements.successTitle.textContent = 'Live readback passed';
    elements.successMessage.textContent =
      'The selected manual execution completed and the newly appended rows were read back from Google Sheets.';
    elements.testStatus.textContent =
      `Passed · ${test.summary?.appendedCount ?? 0} new rows read back and workflow inactive at ${checkedAt ?? 'check time'}`;
  } else if (testOutcome === 'needs-attention') {
    elements.successPanel.classList.add('attention');
    elements.successMark.textContent = '!';
    elements.successEyebrow.textContent = 'Test completed · needs attention';
    const summary = test?.summary;
    const count = (value) => (
      Number.isInteger(value) && value >= 0 ? value : null
    );
    const appendedCount = count(summary?.appendedCount);
    const retrievalFailures = [
      [count(summary?.failedSearches), 'job search'],
      [count(summary?.failedJobDetails), 'job details'],
      [count(summary?.failedCompanies), 'company details'],
    ]
      .filter(([value]) => value !== null && value > 0)
      .map(([value, label]) => `${value} ${label}`);
    const savedText = appendedCount === null
      ? null
      : `${appendedCount} ${appendedCount === 1 ? 'job' : 'jobs'} saved`;
    if (
      test?.failureCategory === 'budget-stopped'
      || summary?.budgetStopped === true
    ) {
      elements.successTitle.textContent = 'The test stopped at its budget limit';
      elements.successMessage.textContent =
        `${savedText ? `${savedText}. ` : ''}Review the recorded execution before another explicitly confirmed bounded test.`;
    } else if (
      test?.failureCategory === 'no-new-rows'
      || test?.failureCategory === 'no-new-jobs'
      || summary?.status === 'no-new-rows'
    ) {
      elements.successTitle.textContent = 'No new jobs were available to verify';
      elements.successMessage.textContent =
        'This run did not add a new row, so it did not verify the new-row write path. Review the search results or sheet before another bounded test.';
    } else if (
      test?.failureCategory === 'write-unverified'
      || summary?.readbackVerified === false
      || summary?.previousRowsUnchanged === false
      || summary?.allFieldsPresent === false
      || summary?.firstSeenAtPresent === false
      || summary?.uniqueIds === false
    ) {
      elements.successTitle.textContent = 'Saved rows were not fully verified';
      elements.successMessage.textContent =
        'The Google Sheets write/readback evidence was incomplete. It cannot be marked as passed.';
    } else if (
      test?.failureCategory === 'partial-run'
      || summary?.status === 'partial'
    ) {
      elements.successTitle.textContent = 'Some jobs could not be retrieved';
      elements.successMessage.textContent =
        savedText && retrievalFailures.length > 0
          ? `${savedText}; ${retrievalFailures.join('; ')} could not be retrieved.`
          : 'Only part of this run could be completed. It cannot be marked as passed.';
    } else {
      elements.successTitle.textContent = 'The test needs attention';
      elements.successMessage.textContent =
        'The run did not produce complete evidence. It cannot be marked as passed.';
    }
    elements.testStatus.textContent =
      `Needs attention · ${test.failureCategory ?? 'review execution'}`;
  } else if (['running', 'unknown', 'execute-requested'].includes(testOutcome)) {
    elements.successPanel.classList.add('attention');
    elements.successMark.textContent = '…';
    elements.successEyebrow.textContent = 'Test in progress';
    elements.successTitle.textContent =
      ['unknown', 'execute-requested'].includes(testOutcome)
        ? 'Execution outcome needs checking'
        : 'Testing the workflow';
    elements.successMessage.textContent =
      ['unknown', 'execute-requested'].includes(testOutcome)
        ? 'Inspect this same execution in n8n. The installer will not start another paid run.'
        : 'Checking the recorded execution. It will not be restarted.';
    elements.testStatus.textContent = test.executionId
      ? `Execution ${test.executionId} · checking is safe and does not rerun the workflow`
      : 'No execution ID was returned · inspect n8n before any new paid run';
  } else if (testOutcome === 'failed') {
    elements.successPanel.classList.add('failed');
    elements.successMark.textContent = '!';
    elements.successEyebrow.textContent = 'Test failed';
    elements.successTitle.textContent = 'Review the n8n execution';
    elements.successMessage.textContent =
      'A paid run was recorded and failed. The installer did not retry it.';
    elements.testStatus.textContent =
      `Failed · ${test.failureCategory ?? 'review execution'} · no automatic retry`;
  } else {
    elements.successPanel.classList.add('attention');
    elements.successMark.textContent = '!';
    elements.successEyebrow.textContent = 'Installed · Test required';
    elements.successTitle.textContent = 'The workflow is installed, but not yet tested';
    elements.successMessage.textContent = checkedAt
      ? `The workflow graph was read back and both account checks passed at ${checkedAt}. No successful workflow run is claimed.`
      : 'The workflow graph was read back. No successful workflow run is claimed.';
    elements.testStatus.textContent = 'Installed · Test required';
  }
  if (workflowUrl) {
    elements.openWorkflow.href = workflowUrl;
    elements.openWorkflow.hidden = false;
  } else {
    elements.openWorkflow.removeAttribute('href');
    elements.openWorkflow.hidden = true;
  }
  const executionId = test?.executionId;
  if (workspaceOrigin && workflowId && executionId) {
    elements.testExecution.href =
      `${workspaceOrigin}/workflow/${encodeURIComponent(workflowId)}/executions/${encodeURIComponent(executionId)}`;
    elements.testExecution.hidden = false;
  } else {
    elements.testExecution.removeAttribute('href');
    elements.testExecution.hidden = true;
  }
  elements.testConsent.checked = false;
  const resume = ['running', 'unknown', 'execute-requested'].includes(testOutcome)
    && Boolean(executionId);
  const canRun = resume || !['passed', 'running'].includes(testOutcome)
    && !['unknown', 'execute-requested'].includes(testOutcome);
  elements.testConsentRow.hidden = resume || testOutcome === 'passed';
  elements.testButton.hidden = !canRun;
  elements.testButton.textContent = resume
    ? 'Check this execution'
    : testOutcome === 'failed' || testOutcome === 'needs-attention'
      ? 'Run another bounded test'
      : 'Run a small test';
  setStep('install');
  clearStatus();
  elements.successPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

elements.workspaceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearStatus();
  setBusy(elements.connectButton, true, 'Opening n8n…');
  try {
    const { workspace, connection } = await beginWorkspaceConnection({
      workspaceInput: elements.workspaceUrl.value,
      redirectUri: `${location.origin}${location.pathname}`,
      storage: session,
      beginOAuth: beginOAuthConnection,
    });
    elements.mcpSettingsLink.href = workspace.settingsMcpUrl;
    location.assign(connection.authorizationUrl);
  } catch (error) {
    setBusy(elements.connectButton, false);
    showError(error);
  }
});

elements.refreshCredentials.addEventListener('click', async () => {
  try {
    await refreshCredentials({ invalidate: true });
    clearStatus();
  } catch (error) {
    showError(error);
  }
});

elements.connectionCheckButton.addEventListener('click', checkConnections);
elements.apifyCredential.addEventListener('change', () => {
  invalidateConnectionCheck(memory.installState, 'apify-credential-changed');
  persistInstallState(memory.installState);
  renderConnectionStatus();
});
elements.googleCredential.addEventListener('change', () => {
  invalidateConnectionCheck(memory.installState, 'google-credential-changed');
  persistInstallState(memory.installState);
  renderConnectionStatus();
});

elements.installForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!memory.client) return;
  const claim = claimInstallSubmit(memory.installState);
  if (!claim.allowed && claim.reason === 'create-attempted') {
    showRecovery('A create request was already submitted. Check its result instead of creating another workflow.');
    return;
  }
  if (!claim.allowed) return;
  setBusy(elements.installButton, true, 'Installing and verifying…');
  clearStatus();
  try {
    const result = await installWorkflow({
      client: memory.client,
      template: WORKFLOW_TEMPLATE,
      manifest: WORKFLOW_MANIFEST,
      settings: formSettings(),
      workflowBaseName: byId('workflow-name').value,
      apifyCredentialId: elements.apifyCredential.value,
      googleCredentialId: elements.googleCredential.value,
      nonce: installationNonce(),
      state: memory.installState,
      onStateChange: persistInstallState,
    });
    showTestPanel(result);
  } catch (error) {
    if (memory.installState.createAttempted) {
      showRecovery(publicErrorMessage(error));
    } else {
      setBusy(elements.installButton, false);
      showError(error);
    }
  } finally {
    releaseInstallSubmit(memory.installState);
  }
});

elements.recoveryButton.addEventListener('click', async () => {
  if (memory.inflightRecovery) return;
  memory.inflightRecovery = true;
  setBusy(elements.recoveryButton, true, 'Checking…');
  clearStatus();
  try {
    const result = await recoverUnknownInstallation({
      client: memory.client,
      manifest: WORKFLOW_MANIFEST,
      state: memory.installState,
      workflowId: elements.recoveryId.value.trim(),
      onStateChange: persistInstallState,
    });
    showTestPanel(result);
  } catch (error) {
    setBusy(elements.recoveryButton, false);
    showError(error);
  } finally {
    memory.inflightRecovery = false;
  }
});

elements.testButton.addEventListener('click', async () => {
  if (!memory.client || !memory.workspace) return;
  const test = memory.installState.testRun;
  const resume = ['running', 'unknown', 'execute-requested'].includes(test?.outcome)
    && Boolean(test.executionId);
  if (!resume && !elements.testConsent.checked) {
    showStatus(
      'Confirm the bounded test',
      'Tick the confirmation before starting a manual run that may call Apify and cost up to $1. This is a cap, not a fixed charge.',
      { error: true },
    );
    return;
  }
  const claim = claimTestSubmit(memory.installState, { resume });
  if (!claim.allowed) {
    showStatus(
      'A test execution is already recorded',
      'Check the recorded n8n execution instead of starting another paid run.',
      { error: true },
    );
    return;
  }
  setBusy(elements.testButton, true, resume ? 'Checking execution…' : 'Running bounded test…');
  elements.testConsent.checked = false;
  clearStatus();
  try {
    const result = resume
      ? await resumeManualTest({
        client: memory.client,
        manifest: WORKFLOW_MANIFEST,
        state: memory.installState,
        onStateChange: persistInstallState,
      })
      : await runManualSmallTest({
        client: memory.client,
        manifest: WORKFLOW_MANIFEST,
        state: memory.installState,
        confirmed: true,
        nonce: installationNonce(),
        onStateChange: persistInstallState,
      });
    showTestPanel(result);
  } catch (error) {
    showTestPanel();
    showError(error);
  } finally {
    releaseTestSubmit(memory.installState);
    setBusy(elements.testButton, false);
  }
});

try {
  const restored = loadInstallRecovery(session);
  if (restored) {
    memory.installState = restored;
    elements.workspaceUrl.value = restored.workspaceOrigin;
    if (restored.legacyReviewRequired) showLegacyRecovery();
  }
} catch (error) {
  showError(error);
}

const callback = callbackLocation();
if (callback) {
  setStep('connect');
  elements.workspacePanel.hidden = true;
  showStatus('Finishing the n8n connection', 'Exchanging the one-time authorization code with n8n…');
  try {
    const connected = await finishOAuthConnection({
      callbackUrl: callback,
      storage: session,
    });
    elements.mcpSettingsLink.href = connected.workspace.settingsMcpUrl;
    await activateConnectedSession(connected.workspace, connected.accessToken);
  } catch (error) {
    showError(error);
    elements.workspacePanel.hidden = false;
    setStep('workspace');
  }
} else {
  try {
    session.remove(OAUTH_SESSION_KEY);
  } catch {
    // A fresh page does not need a stale in-flight OAuth attempt.
  }
  setStep('workspace');
}
