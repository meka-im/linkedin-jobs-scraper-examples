import { InstallerError } from './errors.js';
import { parseWorkspaceUrl } from './workspace.js';

export const INSTALL_RECOVERY_KEY = 'meka.n8n.installer.recovery';
const RECOVERY_STATUSES = new Set(['unknown', 'created-unverified']);
const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,200}$/u;

function safeIdentity(identity) {
  if (
    !identity
    || typeof identity !== 'object'
    || typeof identity.name !== 'string'
    || !/^MEKA(?:\s|$)/u.test(identity.name)
    || identity.name.length > 128
    || typeof identity.nonce !== 'string'
    || !/^[A-Z0-9]{8}$/u.test(identity.nonce)
    || typeof identity.description !== 'string'
    || identity.description.length > 512
  ) {
    return null;
  }
  return {
    name: identity.name,
    nonce: identity.nonce,
    description: identity.description,
  };
}

function safeSettingsProof(proof) {
  if (
    !proof
    || proof.version !== 1
    || proof.algorithm !== 'SHA-256'
    || typeof proof.salt !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(proof.salt)
    || typeof proof.digest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(proof.digest)
  ) {
    return null;
  }
  return {
    version: 1,
    algorithm: 'SHA-256',
    salt: proof.salt,
    digest: proof.digest,
  };
}

export function saveInstallRecovery(storage, state) {
  if (!state?.createAttempted || !RECOVERY_STATUSES.has(state.status)) {
    try {
      storage.remove(INSTALL_RECOVERY_KEY);
    } catch {
      // Completed or pre-create states do not need a recovery marker.
    }
    return;
  }
  const identity = safeIdentity(state.identity);
  const settingsProof = safeSettingsProof(state.settingsProof);
  const workspace = state.workspaceOrigin
    ? parseWorkspaceUrl(state.workspaceOrigin)
    : null;
  const workflowId = typeof state.workflowId === 'string' && WORKFLOW_ID.test(state.workflowId)
    ? state.workflowId
    : null;
  if (!identity || !workspace || !settingsProof) {
    throw new InstallerError(
      'INSTALL_RECOVERY_UNAVAILABLE',
      'The installer could not save a safe recovery marker.',
    );
  }
  storage.set(INSTALL_RECOVERY_KEY, JSON.stringify({
    version: 1,
    createAttempted: true,
    status: state.status,
    identity,
    workspaceOrigin: workspace.origin,
    workflowId,
    settingsProof,
  }));
}

export function loadInstallRecovery(storage) {
  const raw = storage.get(INSTALL_RECOVERY_KEY);
  if (!raw) return null;
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    storage.remove(INSTALL_RECOVERY_KEY);
    return null;
  }
  const identity = safeIdentity(marker?.identity);
  const settingsProof = safeSettingsProof(marker?.settingsProof);
  let workspace;
  try {
    workspace = parseWorkspaceUrl(marker?.workspaceOrigin);
  } catch {
    workspace = null;
  }
  if (
    marker?.version !== 1
    || marker.createAttempted !== true
    || !RECOVERY_STATUSES.has(marker.status)
    || !identity
    || !workspace
    || !settingsProof
    || (marker.workflowId != null && (
      typeof marker.workflowId !== 'string'
      || !WORKFLOW_ID.test(marker.workflowId)
    ))
  ) {
    storage.remove(INSTALL_RECOVERY_KEY);
    return null;
  }
  return {
    createAttempted: true,
    status: marker.status,
    identity,
    workspaceOrigin: workspace.origin,
    workflowId: marker.workflowId ?? null,
    settingsProof,
  };
}

export function clearInstallRecovery(storage) {
  storage.remove(INSTALL_RECOVERY_KEY);
}
