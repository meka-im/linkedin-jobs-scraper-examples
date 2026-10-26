import {
  beginOAuthConnection,
  finishOAuthConnection,
} from './lib/oauth.js';
import {
  beginWorkspaceConnection,
  claimInstallSubmit,
  releaseInstallSubmit,
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
  installForm: byId('install-form'),
  installButton: byId('install-button'),
  recoveryId: byId('recovery-id'),
  recoveryButton: byId('recovery-button'),
  openExisting: byId('open-existing'),
  successTitle: byId('success-title'),
  successMessage: byId('success-message'),
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
    if (memory.installState.workspaceOrigin !== workspace.origin) {
      elements.setupPanel.hidden = true;
      setStep('install');
      showStatus(
        'Another workspace has an interrupted installation',
        'Connect the workspace named by the saved install marker before checking it. No workflow was created.',
        { error: true },
      );
    } else {
      elements.setupPanel.hidden = true;
      showRecovery(
        'Reconnect completed. Check the existing workflow before starting any new installation.',
      );
    }
  } else {
    setStep('connect');
    await refreshCredentials();
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

async function refreshCredentials() {
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
    credentialInstructions();
  } finally {
    setBusy(elements.refreshCredentials, false);
  }
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

function showRecovery(message) {
  elements.installForm.hidden = true;
  elements.recoveryPanel.hidden = false;
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
  showStatus('Installation state unknown', message, { error: true });
}

function persistInstallState(state) {
  saveInstallRecovery(session, state);
}

function showSuccess(result) {
  elements.recoveryPanel.hidden = true;
  elements.setupPanel.hidden = true;
  elements.successPanel.hidden = false;
  elements.successTitle.textContent = result.name;
  elements.successMessage.textContent = 'The inactive workflow is installed and its graph matches the verified MEKA template.';
  elements.openWorkflow.href = result.url ?? result.openUrl;
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
    await refreshCredentials();
    clearStatus();
  } catch (error) {
    showError(error);
  }
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
    showSuccess(result);
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
    showSuccess(result);
  } catch (error) {
    setBusy(elements.recoveryButton, false);
    showError(error);
  } finally {
    memory.inflightRecovery = false;
  }
});

try {
  const restored = loadInstallRecovery(session);
  if (restored) {
    memory.installState = restored;
    elements.workspaceUrl.value = restored.workspaceOrigin;
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
