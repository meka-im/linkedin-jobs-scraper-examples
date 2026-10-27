import { beginOAuthConnection } from './oauth.js';
import { parseWorkspaceUrl } from './workspace.js';

export async function beginWorkspaceConnection({
  workspaceInput,
  redirectUri,
  storage,
  beginOAuth = beginOAuthConnection,
}) {
  const workspace = parseWorkspaceUrl(workspaceInput);
  const connection = await beginOAuth({
    workspace: workspace.origin,
    redirectUri,
    storage,
  });
  return { workspace, connection };
}

export function claimInstallSubmit(state) {
  if (state.createAttempted) {
    return { allowed: false, reason: 'create-attempted' };
  }
  if (state.inflightInstall) {
    return { allowed: false, reason: 'in-flight' };
  }
  state.inflightInstall = true;
  return { allowed: true, reason: null };
}

export function releaseInstallSubmit(state) {
  state.inflightInstall = false;
}

export function claimConnectionCheck(state) {
  if (state.inflightConnectionCheck) {
    return { allowed: false, reason: 'in-flight' };
  }
  const check = state.connectionCheck;
  if (
    check?.executionRequested === true
    && !check.executionId
    && !(
      check.status === 'failed'
      && check.phase === 'execute-rejected'
    )
  ) {
    return { allowed: false, reason: 'execution-unknown' };
  }
  state.inflightConnectionCheck = true;
  return { allowed: true, reason: null };
}

export function releaseConnectionCheck(state) {
  state.inflightConnectionCheck = false;
}

export function claimTestSubmit(state, { resume = false } = {}) {
  if (state.inflightTest) {
    return { allowed: false, reason: 'in-flight' };
  }
  const test = state.testRun;
  if (resume) {
    if (
      test?.executeRequested === true
      && test.executionId
      && ['running', 'unknown', 'execute-requested'].includes(test.outcome)
    ) {
      state.inflightTest = true;
      return { allowed: true, reason: null };
    }
    return { allowed: false, reason: 'resume-unavailable' };
  }
  if (
    test?.executeRequested === true
    && !test.executionId
    && test.failureCategory !== 'execute-rejected'
  ) {
    return { allowed: false, reason: 'execution-unknown' };
  }
  if (
    test?.executeRequested === true
    && test.executionId
    && ['running', 'unknown', 'execute-requested'].includes(test.outcome)
  ) {
    return { allowed: false, reason: 'execution-recorded' };
  }
  state.inflightTest = true;
  return { allowed: true, reason: null };
}

export function releaseTestSubmit(state) {
  state.inflightTest = false;
}
