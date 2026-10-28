import { InstallerError } from './errors.js';
import { normalizedExecutionOptions } from './node-options.js';
import {
  searchSettingsFromAssignments,
  verifySettingsProof,
} from './settings-proof.js';
import {
  createWorkflowVersionFingerprint,
  readWorkflowVersionId,
} from './workflow-fingerprint.js';
import { CREDENTIAL_NODE_NAMES } from './workflow-code.js';

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameJson(left, right) {
  return stable(left) === stable(right);
}

function canonicalConnections(connections) {
  return Object.fromEntries(
    Object.entries(connections ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, outputs]) => [
        source,
        Object.fromEntries(
          Object.entries(outputs)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([kind, branches]) => [
              kind,
              branches.map((targets) => [...targets].sort((left, right) => (
                `${left.node}:${left.index}`.localeCompare(`${right.node}:${right.index}`)
              ))),
            ]),
        ),
      ]),
  );
}

function expectedSearchParameters(manifest, settings, actual) {
  const search = manifest.nodes.find((node) => node.name === 'Search settings');
  if (!search) {
    throw new InstallerError('WORKFLOW_READBACK_INVALID', 'The installer manifest has no Search settings node.');
  }
  const expected = structuredClone(search.parameters);
  const assignments = expected.assignments?.assignments;
  if (!Array.isArray(assignments)) {
    throw new InstallerError('WORKFLOW_READBACK_INVALID', 'The installer manifest has invalid Search settings.');
  }
  const actualAssignments = actual?.parameters?.assignments?.assignments;
  if (settings == null && !Array.isArray(actualAssignments)) {
    throw new InstallerError(
      'WORKFLOW_READBACK_INVALID',
      'The created workflow has invalid Search settings after reload recovery.',
    );
  }
  for (const assignment of assignments) {
    if (settings != null && Object.hasOwn(settings, assignment.name)) {
      assignment.value = settings[assignment.name];
      continue;
    }
    const matches = actualAssignments.filter((item) => item?.name === assignment.name);
    if (matches.length !== 1) {
      throw new InstallerError(
        'WORKFLOW_READBACK_INVALID',
        `Search settings assignment ${assignment.name} is missing or duplicated.`,
      );
    }
    assignment.value = matches[0].value;
  }
  return { ...search, parameters: expected };
}

function readbackWorkflow(payload) {
  if (payload?.workflow && typeof payload.workflow === 'object') return payload.workflow;
  if (payload?.workflowId && Array.isArray(payload.nodes)) return payload;
  if (payload?.id && Array.isArray(payload.nodes)) return payload;
  throw new InstallerError('WORKFLOW_READBACK_INVALID', 'n8n returned no workflow graph for verification.');
}

function expectedCredentialTypes() {
  return new Map([
    ...CREDENTIAL_NODE_NAMES.apifyOAuth2Api.map(
      (name) => [name, 'apifyOAuth2Api'],
    ),
    ...CREDENTIAL_NODE_NAMES.googleSheetsOAuth2Api.map(
      (name) => [name, 'googleSheetsOAuth2Api'],
    ),
  ]);
}

function rejectLegacyManualBudgetTemplate(expected, actual) {
  if (expected.name !== 'Validate Cloud Settings') return;
  const actualCode = actual?.parameters?.jsCode;
  if (
    typeof actualCode === 'string'
    && /Math\.min\s*\(\s*budgetUsd\s*,\s*1\s*\)/u.test(actualCode)
  ) {
    throw new InstallerError(
      'LEGACY_MANUAL_BUDGET_TEMPLATE',
      'This workflow uses an older $1 manual-test template. Reinstall the latest $0.05 template before running it; MEKA will not update the existing workflow.',
    );
  }
}

function credentialReadback(actualNodes, apifyCredentialId, googleCredentialId) {
  if (
    typeof apifyCredentialId !== 'string'
    || !apifyCredentialId
    || typeof googleCredentialId !== 'string'
    || !googleCredentialId
  ) {
    throw new InstallerError(
      'WORKFLOW_CREDENTIAL_BINDING_UNAVAILABLE',
      'The installer cannot bind this workflow to the checked Apify and Google credentials.',
    );
  }
  const expected = expectedCredentialTypes();
  const expectedIds = {
    apifyOAuth2Api: apifyCredentialId,
    googleSheetsOAuth2Api: googleCredentialId,
  };
  let exposed = 0;
  let missing = 0;
  for (const [nodeName, credentialType] of expected) {
    const node = actualNodes.get(nodeName);
    if (!node) continue;
    if (!Object.hasOwn(node, 'credentials')) {
      missing += 1;
      continue;
    }
    exposed += 1;
    const credentials = node.credentials;
    if (
      !credentials
      || typeof credentials !== 'object'
      || Array.isArray(credentials)
      || !sameJson(Object.keys(credentials).sort(), [credentialType])
    ) {
      throw new InstallerError(
        'WORKFLOW_CREDENTIAL_REFERENCE_MISMATCH',
        `Node “${nodeName}” does not expose the reviewed credential type.`,
      );
    }
    const reference = credentials[credentialType];
    const referenceId = typeof reference === 'string'
      ? reference
      : reference?.id;
    if (
      typeof referenceId !== 'string'
      || referenceId !== expectedIds[credentialType]
      || (
        reference
        && typeof reference === 'object'
        && reference.name != null
        && typeof reference.name !== 'string'
      )
    ) {
      throw new InstallerError(
        'WORKFLOW_CREDENTIAL_REFERENCE_MISMATCH',
        `Node “${nodeName}” is not bound to the credential checked by this installer.`,
      );
    }
  }
  for (const node of actualNodes.values()) {
    if (
      Object.hasOwn(node, 'credentials')
      && !expected.has(node.name)
    ) {
      throw new InstallerError(
        'WORKFLOW_CREDENTIAL_REFERENCE_UNEXPECTED',
        `Node “${node.name}” has an unexpected credential reference.`,
      );
    }
  }
  if (exposed > 0 && missing > 0) {
    throw new InstallerError(
      'WORKFLOW_CREDENTIAL_REFERENCE_PARTIAL',
      'n8n exposed only part of the credential-reference graph.',
    );
  }
  return {
    credentialReferenceReadback: exposed === expected.size
      ? 'verified'
      : 'not-exposed',
    credentialReferenceCount: exposed,
  };
}

export async function verifyInstalledWorkflow({
  details,
  manifest,
  settings,
  settingsProof,
  apifyCredentialId,
  googleCredentialId,
  workflowId,
  workflowName,
  workspaceOrigin,
}) {
  const workflow = readbackWorkflow(details);
  if (workflow.id !== workflowId && details?.workflowId !== workflowId) {
    throw new InstallerError('WORKFLOW_ID_MISMATCH', 'n8n returned a different workflow than the one created.');
  }
  if (workflow.name !== workflowName) {
    throw new InstallerError('WORKFLOW_NAME_MISMATCH', 'The created workflow name did not match the request.');
  }
  if (workflow.active !== false) {
    throw new InstallerError(
      'WORKFLOW_ACTIVE',
      'The created workflow is active. The installer will not report it as ready.',
    );
  }
  if (!Array.isArray(workflow.nodes) || !workflow.nodes.length) {
    throw new InstallerError('WORKFLOW_READBACK_INVALID', 'The workflow readback has no nodes.');
  }
  if (!workflow.connections || typeof workflow.connections !== 'object' || Array.isArray(workflow.connections)) {
    throw new InstallerError('WORKFLOW_READBACK_INVALID', 'The workflow readback has no connection graph.');
  }
  if (workflow.nodes.length !== manifest.nodeCount) {
    throw new InstallerError(
      'WORKFLOW_NODE_COUNT_MISMATCH',
      `The workflow has ${workflow.nodes.length} nodes; expected ${manifest.nodeCount}.`,
    );
  }

  const actualNodes = new Map();
  for (const node of workflow.nodes) {
    if (!node || typeof node.name !== 'string' || actualNodes.has(node.name)) {
      throw new InstallerError('WORKFLOW_READBACK_INVALID', 'The workflow readback has duplicate or unnamed nodes.');
    }
    actualNodes.set(node.name, node);
  }

  for (const expected of manifest.nodes) {
    const actual = actualNodes.get(expected.name);
    if (!actual) {
      throw new InstallerError(
        'WORKFLOW_NODE_MISSING',
        `The created workflow is missing node “${expected.name}”.`,
      );
    }
    const expectedNode = expected.name === 'Search settings'
      ? expectedSearchParameters(manifest, settings, actual)
      : expected;
    if (actual.type !== expectedNode.type || actual.typeVersion !== expectedNode.typeVersion) {
      throw new InstallerError(
        'WORKFLOW_NODE_TYPE_MISMATCH',
        `Node “${expectedNode.name}” has the wrong type or version.`,
      );
    }
    if (!sameJson(actual.parameters, expectedNode.parameters)) {
      rejectLegacyManualBudgetTemplate(expectedNode, actual);
      throw new InstallerError(
        'WORKFLOW_PARAMETERS_MISMATCH',
        `Node “${expectedNode.name}” parameters did not survive creation.`,
      );
    }
    if (!sameJson(
      normalizedExecutionOptions(actual),
      expectedNode.executionOptions,
    )) {
      throw new InstallerError(
        'WORKFLOW_NODE_OPTION_MISMATCH',
        `Node “${expectedNode.name}” has different execution options.`,
      );
    }
  }

  if (!sameJson(
    canonicalConnections(workflow.connections),
    canonicalConnections(manifest.connections),
  )) {
    throw new InstallerError(
      'WORKFLOW_CONNECTIONS_MISMATCH',
      'The workflow connection graph did not survive creation.',
    );
  }

  if (settings == null) {
    const actualSearch = actualNodes.get('Search settings');
    const actualSettings = searchSettingsFromAssignments(
      actualSearch?.parameters?.assignments?.assignments,
    );
    await verifySettingsProof(actualSettings, settingsProof);
  }

  const workflowSettings = workflow.settings ?? {};
  if (workflowSettings.executionOrder !== 'v1') {
    throw new InstallerError('WORKFLOW_SETTINGS_MISMATCH', 'The workflow execution order setting is not v1.');
  }
  if (workflowSettings.timezone !== 'UTC') {
    throw new InstallerError(
      'WORKFLOW_TIMEZONE_MISMATCH',
      'The workflow timezone is not UTC. Set it explicitly in n8n before enabling the schedule.',
    );
  }
  if (workflowSettings.availableInMCP !== true) {
    throw new InstallerError(
      'WORKFLOW_MCP_HIDDEN',
      'n8n did not expose the created workflow to the same MCP session for readback.',
    );
  }

  const credentials = credentialReadback(
    actualNodes,
    apifyCredentialId,
    googleCredentialId,
  );
  const expectedUrl = `${workspaceOrigin}/workflow/${encodeURIComponent(workflowId)}`;
  const workflowVersionId = readWorkflowVersionId(details);
  const workflowVersionFingerprint = await createWorkflowVersionFingerprint(details);
  return Object.freeze({
    workflowId,
    workflowName,
    openUrl: expectedUrl,
    graphVerified: true,
    verificationStatus: 'structure-only',
    pinDataReadbackVisibility: 'not-exposed',
    executionPinningCheck: 'required-on-terminal-execution',
    workflowVersionId,
    workflowVersionFingerprint,
    connectionCount: manifest.connectionCount,
    nodeCount: manifest.nodeCount,
    active: false,
    timezone: 'UTC',
    availableInMCP: true,
    credentialBindingsSubmitted: manifest.credentialNodeCounts.apify
      + manifest.credentialNodeCounts.google,
    credentialReadbackVisibility: credentials.credentialReferenceReadback,
    credentialReferenceCount: credentials.credentialReferenceCount,
    searchSettingsReadbackVisibility: settings == null ? 'exact-via-salted-digest' : 'exact',
  });
}
