import { InstallerError } from './errors.js';

const MCP_PATH = '/mcp-server/http';
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource/mcp-server/http';
const WORKSPACE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.app\.n8n\.cloud$/;

export function parseWorkspaceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InstallerError(
      'WORKSPACE_REQUIRED',
      'Enter your n8n Cloud workspace address.',
    );
  }

  const input = value.trim();
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new InstallerError(
      'WORKSPACE_INVALID',
      'Use the full HTTPS address, for example https://your-workspace.app.n8n.cloud.',
    );
  }

  const host = url.hostname.toLowerCase();
  const explicitAuthority = input.startsWith('https://')
    ? input.slice('https://'.length).split(/[/?#]/u, 1)[0]
    : '';
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || explicitAuthority.includes(':')
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
    || !WORKSPACE_HOST.test(host)
  ) {
    throw new InstallerError(
      'WORKSPACE_INVALID',
      'Use only https://<workspace>.app.n8n.cloud with no path, query, fragment, port, or sign-in details.',
    );
  }

  const origin = `https://${host}`;
  return Object.freeze({
    origin,
    slug: host.slice(0, -'.app.n8n.cloud'.length),
    mcpUrl: `${origin}${MCP_PATH}`,
    protectedResourceMetadataUrl: `${origin}${PROTECTED_RESOURCE_PATH}`,
    settingsMcpUrl: `${origin}/settings/mcp`,
    workflowUrl: (id) => {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
        throw new InstallerError('WORKFLOW_ID_INVALID', 'n8n returned an invalid workflow ID.');
      }
      return `${origin}/workflow/${id}`;
    },
  });
}

export function assertSameOriginUrl(value, expectedOrigin, label = 'OAuth endpoint') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InstallerError('OAUTH_METADATA_INVALID', `${label} is not a valid URL.`);
  }

  if (
    url.protocol !== 'https:'
    || url.origin !== expectedOrigin
    || url.username
    || url.password
    || url.hash
  ) {
    throw new InstallerError(
      'OAUTH_ORIGIN_MISMATCH',
      `${label} must stay on the selected n8n Cloud workspace.`,
    );
  }
  return url.toString();
}

export const workspacePaths = Object.freeze({
  mcp: MCP_PATH,
  protectedResourceMetadata: PROTECTED_RESOURCE_PATH,
});
