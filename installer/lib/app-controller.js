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
