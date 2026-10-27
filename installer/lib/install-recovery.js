import { InstallerError } from './errors.js';
import { parseWorkspaceUrl } from './workspace.js';

export const INSTALL_RECOVERY_KEY = 'meka.n8n.hub.onboarding.v2';
export const LEGACY_INSTALL_RECOVERY_KEYS = Object.freeze([
  'meka.n8n.hub.recovery.v1',
  'meka.n8n.installer.recovery',
]);

const STATUSES = new Set([
  'not-checked',
  'checking',
  'failed',
  'checked',
  'created-unverified',
  'installed-pending-test',
  'running',
  'unknown',
  'tested',
]);
const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const EXECUTION_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const NONCE = /^[A-Z0-9]{8}$/u;
const LEGACY_REVIEW_REASONS = new Set([
  'legacy-workflow-manifest-changed',
  'legacy-recovery-marker-invalid',
]);

function safeIdentity(identity) {
  if (
    !identity
    || typeof identity !== 'object'
    || typeof identity.name !== 'string'
    || !/^MEKA(?:\s|$)/u.test(identity.name)
    || identity.name.length > 128
    || typeof identity.nonce !== 'string'
    || !NONCE.test(identity.nonce)
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

function safeId(value) {
  return typeof value === 'string' && WORKFLOW_ID.test(value) ? value : null;
}

function safeExecutionId(value) {
  return typeof value === 'string' && EXECUTION_ID.test(value) ? value : null;
}

function safeFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT.test(value) ? value : null;
}

function safeVersionId(value) {
  return typeof value === 'string' && WORKFLOW_ID.test(value) ? value : null;
}

function safeConnectionEvidence(evidence, workspaceOrigin) {
  if (
    !evidence
    || evidence.version !== 1
    || evidence.workspaceOrigin !== workspaceOrigin
    || !safeId(evidence.workflowId)
    || !safeExecutionId(evidence.executionId)
    || !safeVersionId(evidence.workflowVersionId)
    || !safeFingerprint(evidence.workflowVersionFingerprint)
    || !safeId(evidence.apifyCredentialId)
    || !safeId(evidence.googleCredentialId)
    || typeof evidence.apifyStatus !== 'string'
    || evidence.apifyStatus.length > 80
    || typeof evidence.googleStatus !== 'string'
    || evidence.googleStatus.length > 80
    || typeof evidence.checkedAt !== 'string'
    || evidence.checkedAt.length > 64
  ) {
    return null;
  }
  return {
    version: 1,
    workspaceOrigin,
    workflowId: evidence.workflowId,
    workflowVersionId: evidence.workflowVersionId,
    workflowVersionFingerprint: evidence.workflowVersionFingerprint,
    executionId: evidence.executionId,
    apifyCredentialId: evidence.apifyCredentialId,
    googleCredentialId: evidence.googleCredentialId,
    apifyStatus: evidence.apifyStatus,
    googleStatus: evidence.googleStatus,
    checkedAt: evidence.checkedAt,
    credentialReferenceReadback:
      evidence.credentialReferenceReadback === 'verified'
        ? 'verified'
        : 'not-exposed',
  };
}

function safeConnectionCheck(check, workspaceOrigin) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) return null;
  const identity = safeIdentity(check.identity);
  if (check.workspaceOrigin !== workspaceOrigin) return null;
  const createAttempted = check.createAttempted === true;
  if (createAttempted && !identity) return null;
  const resetAttempt = check.resetAttempt;
  const safeResetAttempt = (
    resetAttempt
    && typeof resetAttempt === 'object'
    && !Array.isArray(resetAttempt)
    && safeId(resetAttempt.previousWorkflowId)
    && (
      resetAttempt.previousExecutionId == null
      || safeExecutionId(resetAttempt.previousExecutionId)
    )
    && (
      resetAttempt.previousOpenUrl == null
      || (
        typeof resetAttempt.previousOpenUrl === 'string'
        && resetAttempt.previousOpenUrl.length <= 512
      )
    )
    && (
      resetAttempt.previousTemplateVersion == null
      || (
        typeof resetAttempt.previousTemplateVersion === 'string'
        && /^[0-9]{1,8}$/u.test(resetAttempt.previousTemplateVersion)
      )
    )
    && typeof resetAttempt.resetAt === 'string'
  )
    ? {
      previousWorkflowId: resetAttempt.previousWorkflowId,
      previousExecutionId: resetAttempt.previousExecutionId ?? null,
      previousOpenUrl: resetAttempt.previousOpenUrl ?? null,
      previousTemplateVersion: resetAttempt.previousTemplateVersion ?? null,
      resetAt: resetAttempt.resetAt.slice(0, 64),
    }
    : null;
  return {
    status: typeof check.status === 'string' ? check.status.slice(0, 80) : 'not-checked',
    phase: typeof check.phase === 'string' ? check.phase.slice(0, 80) : null,
    identity,
    workspaceOrigin,
    apifyCredentialId: safeId(check.apifyCredentialId),
    googleCredentialId: safeId(check.googleCredentialId),
    apifyCredentialName: typeof check.apifyCredentialName === 'string'
      && check.apifyCredentialName.length <= 128
      ? check.apifyCredentialName
      : null,
    googleCredentialName: typeof check.googleCredentialName === 'string'
      && check.googleCredentialName.length <= 128
      ? check.googleCredentialName
      : null,
    createAttempted: check.createAttempted === true,
    executionRequested: check.executionRequested === true,
    executionId: safeExecutionId(check.executionId),
    executionRequestedAt: typeof check.executionRequestedAt === 'string'
      ? check.executionRequestedAt.slice(0, 64)
      : null,
    workflowId: safeId(check.workflowId),
    workflowVersionId: safeVersionId(check.workflowVersionId),
    workflowVersionFingerprint: safeFingerprint(check.workflowVersionFingerprint),
    templateVersion: typeof check.templateVersion === 'string'
      && /^[0-9]{1,8}$/u.test(check.templateVersion)
      ? check.templateVersion
      : null,
    openUrl: typeof check.openUrl === 'string' && check.openUrl.length <= 512
      ? check.openUrl
      : null,
    apifyStatus: typeof check.apifyStatus === 'string'
      ? check.apifyStatus.slice(0, 80)
      : null,
    googleStatus: typeof check.googleStatus === 'string'
      ? check.googleStatus.slice(0, 80)
      : null,
    checkedAt: typeof check.checkedAt === 'string' ? check.checkedAt.slice(0, 64) : null,
    invalidationReason: typeof check.invalidationReason === 'string'
      ? check.invalidationReason.slice(0, 80)
      : null,
    resetAttempt: safeResetAttempt,
    evidence: safeConnectionEvidence(check.evidence, workspaceOrigin),
  };
}

function safeSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
  const strings = [
    'status',
    'failureCategory',
    'coverage',
    'executionMode',
  ];
  const numbers = [
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
  ];
  const booleans = [
    'testPassed',
    'budgetStopped',
    'readbackVerified',
    'previousRowsUnchanged',
    'allFieldsPresent',
    'firstSeenAtPresent',
    'uniqueIds',
    'manualRun',
    'companyEnrichmentDisabled',
  ];
  const output = {};
  for (const name of strings) {
    if (typeof summary[name] === 'string' && summary[name].length <= 80) {
      output[name] = summary[name];
    }
  }
  for (const name of numbers) {
    if (Number.isFinite(summary[name])) output[name] = Number(summary[name]);
  }
  for (const name of booleans) {
    if (typeof summary[name] === 'boolean') output[name] = summary[name];
  }
  return output;
}

function safeTestRun(test, workspaceOrigin) {
  if (
    !test
    || typeof test !== 'object'
    || Array.isArray(test)
    || test.workspaceOrigin !== workspaceOrigin
    || !safeId(test.workflowId)
    || typeof test.nonce !== 'string'
    || !NONCE.test(test.nonce)
    || !safeVersionId(test.workflowVersionId)
    || !safeFingerprint(test.workflowVersionFingerprint)
  ) {
    return null;
  }
  return {
    version: 1,
    policy: typeof test.policy === 'string' ? test.policy.slice(0, 80) : null,
    nonce: test.nonce,
    intentId: typeof test.intentId === 'string' ? test.intentId.slice(0, 160) : null,
    executeRequested: test.executeRequested === true,
    executionId: safeExecutionId(test.executionId),
    workflowId: test.workflowId,
    workflowVersionId: test.workflowVersionId,
    workflowName: typeof test.workflowName === 'string'
      ? test.workflowName.slice(0, 128)
      : null,
    workspaceOrigin,
    workflowVersionFingerprint: test.workflowVersionFingerprint,
    workflowUrl: typeof test.workflowUrl === 'string' ? test.workflowUrl.slice(0, 512) : null,
    startedAt: typeof test.startedAt === 'string' ? test.startedAt.slice(0, 64) : null,
    finishedAt: typeof test.finishedAt === 'string' ? test.finishedAt.slice(0, 64) : null,
    lastCheckedAt: typeof test.lastCheckedAt === 'string'
      ? test.lastCheckedAt.slice(0, 64)
      : null,
    outcome: typeof test.outcome === 'string' ? test.outcome.slice(0, 80) : null,
    failureCategory: typeof test.failureCategory === 'string'
      ? test.failureCategory.slice(0, 80)
      : null,
    testPassed: test.testPassed === true,
    inactiveAtCheck: test.inactiveAtCheck === true,
    scheduleActive: false,
    summary: safeSummary(test.summary),
  };
}

export function saveInstallRecovery(storage, state) {
  if (
    !state
    || !STATUSES.has(state.status)
    || (!state.createAttempted && !state.connectionCheck && !state.testRun)
  ) {
    try {
      storage.remove(INSTALL_RECOVERY_KEY);
    } catch {
      // Pre-create empty states do not need a recovery marker.
    }
    return;
  }
  const identity = safeIdentity(state.identity);
  const settingsProof = safeSettingsProof(state.settingsProof);
  const workspace = state.workspaceOrigin
    ? parseWorkspaceUrl(state.workspaceOrigin)
    : null;
  const connectionCheck = workspace
    ? safeConnectionCheck(state.connectionCheck, workspace.origin)
    : null;
  const testRun = workspace
    ? safeTestRun(state.testRun, workspace.origin)
    : null;
  const legacyReviewRequired = state.legacyReviewRequired === true;
  if (
    !workspace
    || (
      legacyReviewRequired
      && !LEGACY_REVIEW_REASONS.has(state.legacyReviewReason)
    )
    || (
      state.createAttempted
      && (!identity || !settingsProof)
    )
    || (
      !state.createAttempted
      && !connectionCheck
    )
  ) {
    throw new InstallerError(
      'INSTALL_RECOVERY_UNAVAILABLE',
      'The installer could not save a safe onboarding marker.',
    );
  }
  storage.set(INSTALL_RECOVERY_KEY, JSON.stringify({
    version: 2,
    status: state.status,
    createAttempted: state.createAttempted === true,
    legacyReviewRequired,
    legacyReviewReason: legacyReviewRequired
      && LEGACY_REVIEW_REASONS.has(state.legacyReviewReason)
      ? state.legacyReviewReason
      : null,
    identity,
    workspaceOrigin: workspace.origin,
    workflowId: safeId(state.workflowId),
    workflowVersionId: safeVersionId(state.workflowVersionId),
    workflowVersionFingerprint: safeFingerprint(state.workflowVersionFingerprint),
    settingsProof: state.createAttempted ? settingsProof : null,
    connectionCheck,
    testRun,
  }));
}

function parseCurrentMarker(raw) {
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
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
  const connectionCheck = workspace
    ? safeConnectionCheck(marker?.connectionCheck, workspace.origin)
    : null;
  const testRun = workspace && marker?.testRun
    ? safeTestRun(marker.testRun, workspace.origin)
    : null;
  if (
    marker?.version !== 2
    || !STATUSES.has(marker.status)
    || typeof marker.createAttempted !== 'boolean'
    || (
      marker.legacyReviewRequired === true
      && !LEGACY_REVIEW_REASONS.has(marker.legacyReviewReason)
    )
    || !workspace
    || (
      marker.createAttempted
      && (!identity || !settingsProof)
    )
    || (
      !marker.createAttempted
      && !connectionCheck
    )
    || (marker.testRun != null && !testRun)
    || (marker.workflowId != null && !safeId(marker.workflowId))
    || (
      marker.workflowVersionId != null
      && !safeVersionId(marker.workflowVersionId)
    )
    || (
      marker.workflowVersionFingerprint != null
      && !safeFingerprint(marker.workflowVersionFingerprint)
    )
  ) {
    return null;
  }
  return {
    status: marker.status,
    createAttempted: marker.createAttempted,
    identity,
    workspaceOrigin: workspace.origin,
    workflowId: marker.workflowId ?? null,
    workflowVersionId: marker.workflowVersionId ?? null,
    workflowVersionFingerprint: marker.workflowVersionFingerprint ?? null,
    settingsProof: marker.createAttempted ? settingsProof : null,
    connectionCheck,
    testRun,
    legacyReviewRequired: marker.legacyReviewRequired === true,
    legacyReviewReason: LEGACY_REVIEW_REASONS.has(marker.legacyReviewReason)
      ? marker.legacyReviewReason
      : null,
  };
}

function legacyBlockingState(reason) {
  return {
    createAttempted: true,
    status: 'unknown',
    identity: null,
    workspaceOrigin: null,
    workflowId: null,
    workflowVersionId: null,
    workflowVersionFingerprint: null,
    settingsProof: null,
    connectionCheck: null,
    testRun: null,
    legacyReviewRequired: true,
    legacyReviewReason: reason,
  };
}

function loadLegacyMarker(storage, key) {
  const raw = storage.get(key);
  if (!raw) return null;
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch {
    // Keep the unreadable legacy value in place as a fail-closed create guard.
    return legacyBlockingState('legacy-recovery-marker-invalid');
  }
  const identity = safeIdentity(marker?.identity);
  const settingsProof = safeSettingsProof(marker?.settingsProof);
  let workspace;
  try {
    workspace = parseWorkspaceUrl(marker?.workspaceOrigin);
  } catch {
    workspace = null;
  }
  const workflowId = marker?.workflowId == null
    ? null
    : safeId(marker.workflowId);
  if (
    marker?.version !== 1
    || marker.createAttempted !== true
    || !['unknown', 'created-unverified'].includes(marker.status)
    || !identity
    || !workspace
    || !settingsProof
    || (marker.workflowId != null && !workflowId)
  ) {
    // A legacy v1 marker proves only that a create may have been sent. Its
    // graph cannot be checked against the v2 manifest, so retain a block.
    return legacyBlockingState('legacy-recovery-marker-invalid');
  }
  const migrated = {
    createAttempted: true,
    status: marker.status,
    identity,
    workspaceOrigin: workspace.origin,
    workflowId,
    workflowVersionId: null,
    workflowVersionFingerprint: null,
    settingsProof,
    connectionCheck: null,
    testRun: null,
    legacyReviewRequired: true,
    legacyReviewReason: 'legacy-workflow-manifest-changed',
  };
  storage.set(INSTALL_RECOVERY_KEY, JSON.stringify({
    version: 2,
    status: migrated.status,
    createAttempted: true,
    legacyReviewRequired: true,
    legacyReviewReason: migrated.legacyReviewReason,
    identity: migrated.identity,
    workspaceOrigin: migrated.workspaceOrigin,
    workflowId: migrated.workflowId,
    workflowVersionId: null,
    workflowVersionFingerprint: null,
    settingsProof: migrated.settingsProof,
    connectionCheck: null,
    testRun: null,
  }));
  storage.remove(key);
  return migrated;
}

export function loadInstallRecovery(storage) {
  const raw = storage.get(INSTALL_RECOVERY_KEY);
  if (raw) {
    const marker = parseCurrentMarker(raw);
    if (marker) return marker;
    // A malformed current marker may still represent an unresolved create.
    // Keep it in place and fail closed instead of allowing another submission.
    return legacyBlockingState('legacy-recovery-marker-invalid');
  }
  for (const key of LEGACY_INSTALL_RECOVERY_KEYS) {
    const marker = loadLegacyMarker(storage, key);
    if (marker) return marker;
  }
  return null;
}

export function clearInstallRecovery(storage) {
  storage.remove(INSTALL_RECOVERY_KEY);
  for (const key of LEGACY_INSTALL_RECOVERY_KEYS) storage.remove(key);
}
