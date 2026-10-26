import { InstallerError } from './errors.js';
import { parseWorkspaceUrl } from './workspace.js';

async function normalizedResponse(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    throw new InstallerError('MCP_RESPONSE_INVALID', 'The MCP response could not be read.');
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    url: response.url,
  };
}

export function createDirectMcpTransport({
  workspace: workspaceValue,
  accessToken,
  fetchImpl = fetch,
  timeoutMs = 45_000,
}) {
  const workspace = typeof workspaceValue === 'string'
    ? parseWorkspaceUrl(workspaceValue)
    : workspaceValue;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new InstallerError('MCP_TOKEN_MISSING', 'Reconnect to n8n before using MCP.');
  }

  return {
    mode: 'direct',
    workspaceOrigin: workspace.origin,
    async post(message, metadata = {}) {
      const headers = {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      };
      if (metadata.protocolVersion) headers['MCP-Protocol-Version'] = metadata.protocolVersion;
      if (metadata.methodName) headers['Mcp-Method'] = metadata.methodName;
      if (metadata.toolName) headers['Mcp-Name'] = metadata.toolName;

      let response;
      try {
        response = await fetchImpl(workspace.mcpUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(message),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new InstallerError(
          'MCP_CORS_OR_NETWORK',
          'This browser could not reach the n8n MCP endpoint. n8n Cloud MCP CORS may be unavailable; use the same-origin installer relay.',
        );
      }
      if (response.status >= 300 && response.status < 400) {
        throw new InstallerError('MCP_REDIRECT_REFUSED', 'The MCP endpoint returned a redirect.');
      }
      return normalizedResponse(response);
    },
  };
}

export function createSameOriginRelayTransport({
  workspace: workspaceValue,
  accessToken,
  fetchImpl = fetch,
  relayUrl = '/api/mcp',
  timeoutMs = 45_000,
}) {
  const workspace = typeof workspaceValue === 'string'
    ? parseWorkspaceUrl(workspaceValue)
    : workspaceValue;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new InstallerError('MCP_TOKEN_MISSING', 'Reconnect to n8n before using MCP.');
  }
  const base = typeof location === 'object' ? location.origin : 'http://127.0.0.1';
  const relay = new URL(relayUrl, base);
  if (relay.origin !== base || relay.pathname !== '/api/mcp' || relay.search || relay.hash) {
    throw new InstallerError('RELAY_URL_INVALID', 'The installer relay address is invalid.');
  }

  return {
    mode: 'same-origin-relay',
    workspaceOrigin: workspace.origin,
    async post(message, metadata = {}) {
      const headers = {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-MEKA-Target-Origin': workspace.origin,
      };
      if (metadata.protocolVersion) headers['MCP-Protocol-Version'] = metadata.protocolVersion;
      if (metadata.methodName) headers['Mcp-Method'] = metadata.methodName;
      if (metadata.toolName) headers['Mcp-Name'] = metadata.toolName;
      let response;
      try {
        response = await fetchImpl(relay.toString(), {
          method: 'POST',
          headers,
          body: JSON.stringify(message),
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new InstallerError(
          'RELAY_UNAVAILABLE',
          'The installer relay is unavailable. Try again shortly.',
        );
      }
      return normalizedResponse(response);
    },
  };
}
