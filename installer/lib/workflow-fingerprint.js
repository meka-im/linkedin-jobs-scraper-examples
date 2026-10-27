import { InstallerError } from './errors.js';

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

function workflowFromDetails(details) {
  return details?.workflow && typeof details.workflow === 'object'
    ? details.workflow
    : details;
}

export function readWorkflowVersionId(details) {
  const workflow = workflowFromDetails(details);
  if (
    typeof workflow?.versionId !== 'string'
    || !/^[A-Za-z0-9_-]{1,200}$/u.test(workflow.versionId)
  ) {
    throw new InstallerError(
      'WORKFLOW_VERSION_UNAVAILABLE',
      'n8n did not expose the workflow version required to bind this test.',
    );
  }
  return workflow.versionId;
}

export async function createWorkflowVersionFingerprint(details) {
  const workflow = workflowFromDetails(details);
  if (
    !workflow
    || typeof workflow !== 'object'
    || !Array.isArray(workflow.nodes)
    || !workflow.connections
  ) {
    throw new InstallerError(
      'WORKFLOW_VERSION_UNAVAILABLE',
      'n8n did not expose enough workflow data to bind this test to a version.',
    );
  }
  const versionId = readWorkflowVersionId(details);
  const payload = stable({
    name: workflow.name ?? null,
    versionId,
    active: workflow.active ?? null,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings ?? {},
  });
  const digest = await globalThis.crypto?.subtle?.digest(
    'SHA-256',
    new TextEncoder().encode(payload),
  );
  if (!digest) {
    throw new InstallerError(
      'CRYPTO_UNAVAILABLE',
      'This browser cannot create a workflow version fingerprint.',
    );
  }
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
