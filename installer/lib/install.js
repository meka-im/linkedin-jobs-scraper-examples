import { InstallerError } from './errors.js';
import {
  APIFY_CREDENTIAL_TYPE,
  GOOGLE_CREDENTIAL_TYPE,
  chooseCredential,
  listCredentialCandidates,
} from './credentials.js';
import { renderWorkflowCode, validateInstallerSettings } from './workflow-code.js';
import { verifyInstalledWorkflow } from './verify-install.js';
import { parseWorkspaceUrl } from './workspace.js';
import { createSettingsProof } from './settings-proof.js';
import { connectionEvidenceIsCurrent } from './connection-check.js';

export const REQUIRED_MCP_TOOLS = Object.freeze([
  'list_credentials',
  'validate_workflow',
  'create_workflow_from_code',
  'get_workflow_details',
  'search_workflows',
  'execute_workflow',
  'get_workflow_execution',
]);

function requireClient(client) {
  if (!client || typeof client.callTool !== 'function' || typeof client.requireTools !== 'function') {
    throw new InstallerError('MCP_CLIENT_INVALID', 'The MCP client is unavailable.');
  }
}

export function makeInstallationIdentity(baseName, nonce) {
  if (typeof baseName !== 'string' || !/^MEKA(?:\s|$)/u.test(baseName.trim())) {
    throw new InstallerError('WORKFLOW_NAME_INVALID', 'The workflow name must begin with MEKA.');
  }
  if (typeof nonce !== 'string' || !/^[A-Z0-9]{8}$/u.test(nonce)) {
    throw new InstallerError('INSTALL_NONCE_INVALID', 'The installation marker is invalid.');
  }
  const base = baseName.trim();
  const suffix = ` · ${nonce}`;
  const maximumBaseLength = 128 - suffix.length;
  const name = `${base.slice(0, maximumBaseLength).trim()}${suffix}`;
  return Object.freeze({
    name,
    nonce,
    description: `Created by the MEKA installer ${nonce}. Inactive; the installer did not run the Actor or publish the schedule.`,
  });
}

export function installationNonce(randomValues = globalThis.crypto) {
  if (!randomValues?.getRandomValues) {
    throw new InstallerError('CRYPTO_UNAVAILABLE', 'This browser cannot create a secure install marker.');
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  randomValues.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

async function validateGeneratedWorkflow(client, code) {
  const validation = await client.callTool('validate_workflow', { code });
  if (validation?.valid !== true) {
    throw new InstallerError(
      'WORKFLOW_VALIDATION_FAILED',
      'n8n rejected the generated workflow. No workflow was created; review the installer build or connection.',
    );
  }
}

function createOutput(payload) {
  if (
    !payload
    || typeof payload.workflowId !== 'string'
    || !payload.workflowId
    || typeof payload.url !== 'string'
    || !payload.url
  ) {
    throw new InstallerError(
      'CREATE_RESULT_UNKNOWN',
      'n8n did not return a complete create result. The installation state is unknown; do not create another workflow.',
    );
  }
  return payload;
}

export async function installWorkflow({
  client,
  template,
  manifest,
  settings,
  workflowBaseName,
  apifyCredentialId = '',
  googleCredentialId = '',
  nonce,
  state = {},
  onStateChange = () => {},
  now = Date.now(),
}) {
  requireClient(client);
  if (state.createAttempted) {
    throw new InstallerError(
      'CREATE_RESULT_UNKNOWN',
      'A create request was already sent. Do not submit another one; check for the uniquely named workflow first.',
    );
  }
  const safeSettings = validateInstallerSettings(settings);
  const identity = makeInstallationIdentity(workflowBaseName, nonce);
  client.requireTools(REQUIRED_MCP_TOOLS);
  const expectedOrigin = client.workspaceOrigin ?? client.transport?.workspaceOrigin;
  if (!expectedOrigin) {
    throw new InstallerError('WORKSPACE_CONTEXT_MISSING', 'The installer lost the selected workspace.');
  }
  const workspace = parseWorkspaceUrl(expectedOrigin);

  const apifyCandidates = await listCredentialCandidates(client, APIFY_CREDENTIAL_TYPE);
  const googleCandidates = await listCredentialCandidates(client, GOOGLE_CREDENTIAL_TYPE);
  const apify = chooseCredential(
    apifyCandidates,
    apifyCredentialId,
    'Apify OAuth',
    APIFY_CREDENTIAL_TYPE,
  );
  const google = chooseCredential(
    googleCandidates,
    googleCredentialId,
    'Google Sheets OAuth',
    GOOGLE_CREDENTIAL_TYPE,
  );
  if (!connectionEvidenceIsCurrent(state.connectionCheck?.evidence, {
    workspaceOrigin: workspace.origin,
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    now,
  })) {
    throw new InstallerError(
      'CONNECTION_CHECK_REQUIRED',
      'Check both connected accounts successfully before installing. The saved check expired or belongs to different credentials.',
    );
  }

  const code = renderWorkflowCode({
    template,
    settings: safeSettings,
    apifyCredential: apify,
    googleCredential: google,
  });
  await validateGeneratedWorkflow(client, code);
  const settingsProof = await createSettingsProof(safeSettings);

  state.createAttempted = true;
  state.status = 'unknown';
  state.identity = identity;
  state.settings = safeSettings;
  state.settingsProof = settingsProof;
  state.workspaceOrigin = workspace.origin;
  state.workflowId = null;
  onStateChange(state);
  let created;
  try {
    created = createOutput(await client.callTool('create_workflow_from_code', {
      code,
      name: identity.name,
      description: identity.description,
      versionName: 'MEKA Cloud installer v1',
      versionDescription: 'Inactive MEKA LinkedIn Jobs workflow with explicitly bound Apify and Google OAuth credentials.',
    }));
  } catch (error) {
    state.status = 'unknown';
    onStateChange(state);
    if (error instanceof InstallerError && error.code === 'CREATE_RESULT_UNKNOWN') throw error;
    throw new InstallerError(
      'CREATE_RESULT_UNKNOWN',
      'The create request ended without a reliable result. Do not create another workflow; check for the uniquely named workflow first.',
      { cause: error },
    );
  }

  state.workflowId = created.workflowId;
  state.status = 'created-unverified';
  onStateChange(state);
  let createdUrl;
  try {
    createdUrl = new URL(created.url);
  } catch {
    state.status = 'created-unverified';
    onStateChange(state);
    throw new InstallerError('CREATE_RESULT_INVALID', 'n8n returned an invalid workflow URL.');
  }
  if (createdUrl.origin !== expectedOrigin || createdUrl.pathname !== `/workflow/${created.workflowId}`) {
    state.status = 'created-unverified';
    onStateChange(state);
    throw new InstallerError('CREATE_RESULT_INVALID', 'n8n returned a workflow URL outside the selected workspace.');
  }
  if (
    Number.isFinite(created.nodeCount)
    && created.nodeCount !== manifest.nodeCount
  ) {
    state.status = 'created-unverified';
    onStateChange(state);
    throw new InstallerError('CREATE_RESULT_INVALID', 'n8n created a workflow with the wrong node count.');
  }

  let details;
  try {
    details = await client.callTool('get_workflow_details', { workflowId: created.workflowId });
  } catch (error) {
    state.status = 'created-unverified';
    onStateChange(state);
    throw new InstallerError(
      'WORKFLOW_READBACK_FAILED',
      'The workflow was created, but n8n did not return a readable verification result. Do not create another workflow.',
      { cause: error },
    );
  }

  let verified;
  try {
    verified = await verifyInstalledWorkflow({
      details,
      manifest,
      settings: safeSettings,
      settingsProof,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      workflowId: created.workflowId,
      workflowName: identity.name,
      workspaceOrigin: expectedOrigin,
    });
  } catch (error) {
    state.status = 'created-unverified';
    onStateChange(state);
    throw error;
  }

  state.workflowVersionId = verified.workflowVersionId;
  state.workflowVersionFingerprint = verified.workflowVersionFingerprint;
  state.status = 'installed-pending-test';
  onStateChange(state);
  return Object.freeze({
    ...verified,
    status: 'installed-pending-test',
    url: created.url,
    name: identity.name,
    nonce,
  });
}

export async function recoverUnknownInstallation({
  client,
  manifest,
  state,
  workflowId,
  onStateChange = () => {},
}) {
  requireClient(client);
  if (state.legacyReviewRequired === true) {
    throw new InstallerError(
      'LEGACY_INSTALL_REVIEW_REQUIRED',
      'An earlier installer version recorded an unresolved create request for a 41-node workflow. Open n8n and identify that workflow manually; it cannot be verified against the reviewed 42-node graph, and this installer will not create another one automatically.',
      {
        safeDetails: {
          workflowUrl: state.workspaceOrigin && state.workflowId
            ? `${state.workspaceOrigin}/workflow/${encodeURIComponent(state.workflowId)}`
            : null,
        },
      },
    );
  }
  if (
    !['unknown', 'created-unverified'].includes(state.status)
    || !state.createAttempted
    || !state.identity
    || !state.workspaceOrigin
  ) {
    throw new InstallerError(
      'INSTALL_RECOVERY_UNAVAILABLE',
      'There is no unresolved create request to check in this browser session.',
    );
  }
  const knownWorkflowId = typeof state.workflowId === 'string' && state.workflowId
    ? state.workflowId
    : null;
  const selectedWorkflowId = typeof workflowId === 'string' && workflowId.trim()
    ? workflowId.trim()
    : knownWorkflowId;
  if (selectedWorkflowId) {
    const details = await client.callTool('get_workflow_details', {
      workflowId: selectedWorkflowId,
    });
    const verified = await verifyInstalledWorkflow({
      details,
      manifest,
      settings: state.settings ?? null,
      settingsProof: state.settingsProof,
      apifyCredentialId: state.connectionCheck?.apifyCredentialId,
      googleCredentialId: state.connectionCheck?.googleCredentialId,
      workflowId: selectedWorkflowId,
      workflowName: state.identity.name,
      workspaceOrigin: state.workspaceOrigin,
    });
    state.workflowVersionId = verified.workflowVersionId;
    state.workflowVersionFingerprint = verified.workflowVersionFingerprint;
    state.status = 'installed-pending-test';
    state.workflowId = selectedWorkflowId;
    onStateChange(state);
    return verified;
  }

  client.requireTools(['search_workflows']);
  const result = await client.callTool('search_workflows', {
    query: state.identity.name,
    limit: 20,
  });
  const workflows = Array.isArray(result?.workflows)
    ? result.workflows
    : Array.isArray(result?.data)
      ? result.data
      : [];
  const matches = workflows.filter((workflow) => workflow?.name === state.identity.name);
  if (matches.length === 0) {
    throw new InstallerError(
      'INSTALL_NOT_FOUND',
      'No workflow with the unique installer name was found. Do not resubmit automatically; verify the n8n workspace first.',
    );
  }
  if (
    matches.length > 1
    || matches.some((workflow) => typeof workflow.id !== 'string' || !workflow.id)
  ) {
    throw new InstallerError(
      'INSTALL_AMBIGUOUS',
      'More than one workflow has the unique installer name. Refusing to choose one.',
    );
  }

  const details = await client.callTool('get_workflow_details', {
    workflowId: matches[0].id,
  });
  const verified = await verifyInstalledWorkflow({
    details,
    manifest,
    settings: state.settings ?? null,
    settingsProof: state.settingsProof,
    apifyCredentialId: state.connectionCheck?.apifyCredentialId,
    googleCredentialId: state.connectionCheck?.googleCredentialId,
    workflowId: matches[0].id,
    workflowName: state.identity.name,
    workspaceOrigin: state.workspaceOrigin,
  });
  state.workflowVersionId = verified.workflowVersionId;
  state.workflowVersionFingerprint = verified.workflowVersionFingerprint;
  state.status = 'installed-pending-test';
  state.workflowId = matches[0].id;
  onStateChange(state);
  return verified;
}
