import { InstallerError } from './errors.js';
import { normalizedExecutionOptions } from './node-options.js';
import {
  searchSettingsFromAssignments,
  verifySettingsProof,
} from './settings-proof.js';

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

export async function verifyInstalledWorkflow({
  details,
  manifest,
  settings,
  settingsProof,
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

  const expectedUrl = `${workspaceOrigin}/workflow/${encodeURIComponent(workflowId)}`;
  return Object.freeze({
    workflowId,
    workflowName,
    openUrl: expectedUrl,
    graphVerified: true,
    connectionCount: manifest.connectionCount,
    nodeCount: manifest.nodeCount,
    active: false,
    timezone: 'UTC',
    availableInMCP: true,
    credentialBindingsSubmitted: 14,
    credentialReadbackVisibility: 'not-exposed',
    searchSettingsReadbackVisibility: settings == null ? 'exact-via-salted-digest' : 'exact',
  });
}
