import { InstallerError } from './errors.js';
import { createPkcePair, randomToken } from './pkce.js';
import {
  clearOAuthSession,
  loadOAuthSession,
  saveOAuthSession,
} from './oauth-session.js';
import { assertSameOriginUrl, parseWorkspaceUrl } from './workspace.js';

export const REQUIRED_SCOPES = Object.freeze([
  'workflow:read',
  'workflow:write',
  'credential:read',
]);
export const OAUTH_TTL_MS = 10 * 60 * 1000;

function normalizeWorkspace(workspaceValue) {
  if (typeof workspaceValue === 'string') return parseWorkspaceUrl(workspaceValue);
  if (workspaceValue && typeof workspaceValue.origin === 'string') {
    return parseWorkspaceUrl(workspaceValue.origin);
  }
  throw new InstallerError('WORKSPACE_REQUIRED', 'Choose an n8n Cloud workspace.');
}

function networkError(label) {
  return new InstallerError(
    'OAUTH_NETWORK_ERROR',
    `${label} could not be reached from this browser. Check the workspace and browser CORS support.`,
  );
}

async function requestUrl(url, fetchImpl, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: options.signal ?? AbortSignal.timeout(15_000),
    });
  } catch {
    throw networkError('The n8n OAuth service');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new InstallerError('OAUTH_REDIRECT_REFUSED', 'The n8n OAuth service returned a redirect.');
  }
  return response;
}

async function readJson(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new InstallerError('OAUTH_RESPONSE_INVALID', `${label} returned invalid JSON.`);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InstallerError('OAUTH_RESPONSE_INVALID', `${label} returned an invalid response.`);
  }
  return body;
}

function sameOriginResource(resource, workspace) {
  let parsed;
  try {
    parsed = new URL(resource);
  } catch {
    return false;
  }
  return parsed.origin === workspace.origin && parsed.pathname === '/mcp-server/http'
    && !parsed.search && !parsed.hash && !parsed.username && !parsed.password && !parsed.port;
}

export function normalizeRedirectUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InstallerError('REDIRECT_URI_INVALID', 'The installer callback address is invalid.');
  }
  const loopback = url.protocol === 'http:'
    && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  if (
    (!loopback && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new InstallerError(
      'REDIRECT_URI_INVALID',
      'The installer callback must be a clean HTTPS address or loopback development address.',
    );
  }
  return url.toString();
}

export async function discoverOAuth({ workspace: workspaceValue, fetchImpl = fetch }) {
  const workspace = normalizeWorkspace(workspaceValue);

  const protectedResponse = await requestUrl(
    workspace.protectedResourceMetadataUrl,
    fetchImpl,
    { headers: { Accept: 'application/json' } },
  );
  if (protectedResponse.status === 404) {
    throw new InstallerError(
      'MCP_DISABLED',
      'MCP is not enabled for this workspace. An administrator must enable MCP access in Settings → MCP first.',
      { safeDetails: { settingsMcpUrl: workspace.settingsMcpUrl } },
    );
  }
  if (!protectedResponse.ok) {
    throw new InstallerError(
      'MCP_DISCOVERY_FAILED',
      `MCP discovery failed with HTTP ${protectedResponse.status}.`,
    );
  }
  const protectedResource = await readJson(protectedResponse, 'MCP discovery');
  if (!sameOriginResource(protectedResource.resource, workspace)) {
    throw new InstallerError(
      'OAUTH_RESOURCE_MISMATCH',
      'MCP discovery returned a resource URL outside the selected workspace.',
    );
  }

  const authorizationServers = protectedResource.authorization_servers;
  if (!Array.isArray(authorizationServers) || authorizationServers.length === 0) {
    throw new InstallerError('OAUTH_METADATA_INVALID', 'MCP discovery did not name an authorization server.');
  }
  const authorizationServer = authorizationServers[0];
  const issuerUrl = assertSameOriginUrl(authorizationServer, workspace.origin, 'Authorization server');
  if (issuerUrl !== `${workspace.origin}/`) {
    throw new InstallerError(
      'OAUTH_METADATA_INVALID',
      'The authorization server issuer must be the selected workspace origin.',
    );
  }

  const metadataUrl = `${workspace.origin}/.well-known/oauth-authorization-server`;
  const metadataResponse = await requestUrl(metadataUrl, fetchImpl, {
    headers: { Accept: 'application/json' },
  });
  if (!metadataResponse.ok) {
    throw new InstallerError(
      'OAUTH_DISCOVERY_FAILED',
      `OAuth discovery failed with HTTP ${metadataResponse.status}.`,
    );
  }
  const metadata = await readJson(metadataResponse, 'OAuth discovery');
  if (metadata.issuer !== workspace.origin && metadata.issuer !== `${workspace.origin}/`) {
    throw new InstallerError(
      'OAUTH_ISSUER_MISMATCH',
      'OAuth discovery returned an issuer outside the selected workspace.',
    );
  }

  const endpoints = {
    authorizationEndpoint: assertSameOriginUrl(
      metadata.authorization_endpoint,
      workspace.origin,
      'Authorization endpoint',
    ),
    tokenEndpoint: assertSameOriginUrl(
      metadata.token_endpoint,
      workspace.origin,
      'Token endpoint',
    ),
    registrationEndpoint: assertSameOriginUrl(
      metadata.registration_endpoint,
      workspace.origin,
      'Registration endpoint',
    ),
  };

  const methods = metadata.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes('S256')) {
    throw new InstallerError(
      'OAUTH_PKCE_UNAVAILABLE',
      'This n8n workspace does not advertise PKCE S256, so the installer will not connect.',
    );
  }
  if (
    Array.isArray(metadata.token_endpoint_auth_methods_supported)
    && !metadata.token_endpoint_auth_methods_supported.includes('none')
  ) {
    throw new InstallerError(
      'OAUTH_PUBLIC_CLIENT_UNSUPPORTED',
      'This workspace does not support public OAuth clients for the installer.',
    );
  }

  const advertisedScopes = protectedResource.scopes_supported ?? metadata.scopes_supported;
  if (Array.isArray(advertisedScopes)) {
    const missing = REQUIRED_SCOPES.filter((scope) => !advertisedScopes.includes(scope));
    if (missing.length > 0) {
      throw new InstallerError(
        'OAUTH_SCOPE_UNAVAILABLE',
        `This workspace does not advertise the required MCP scopes: ${missing.join(', ')}.`,
      );
    }
  }

  return Object.freeze({
    workspace,
    resource: workspace.mcpUrl,
    issuer: metadata.issuer,
    ...endpoints,
    scopes: [...REQUIRED_SCOPES],
    advertisedScopes: Array.isArray(advertisedScopes) ? [...advertisedScopes] : null,
  });
}

export async function beginOAuthConnection({
  workspace,
  redirectUri,
  storage,
  fetchImpl = fetch,
  now = Date.now(),
}) {
  const parsedWorkspace = normalizeWorkspace(workspace);
  const cleanRedirectUri = normalizeRedirectUri(redirectUri);
  const discovery = await discoverOAuth({ workspace: parsedWorkspace, fetchImpl });
  const registrationResponse = await requestUrl(discovery.registrationEndpoint, fetchImpl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_name: 'MEKA n8n Cloud installer',
      redirect_uris: [cleanRedirectUri],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!registrationResponse.ok) {
    throw new InstallerError(
      'OAUTH_REGISTRATION_FAILED',
      `OAuth client registration failed with HTTP ${registrationResponse.status}.`,
    );
  }
  const registration = await readJson(registrationResponse, 'OAuth client registration');
  if (
    typeof registration.client_id !== 'string'
    || !registration.client_id
    || (registration.client_secret != null && registration.client_secret !== '')
  ) {
    throw new InstallerError(
      'OAUTH_REGISTRATION_INVALID',
      'OAuth registration did not return a public client ID.',
    );
  }

  const state = randomToken(32);
  const pkce = await createPkcePair();
  const session = {
    createdAt: now,
    state,
    codeVerifier: pkce.verifier,
    workspaceOrigin: parsedWorkspace.origin,
    mcpUrl: parsedWorkspace.mcpUrl,
    issuer: discovery.issuer,
    authorizationEndpoint: discovery.authorizationEndpoint,
    tokenEndpoint: discovery.tokenEndpoint,
    clientId: registration.client_id,
    redirectUri: cleanRedirectUri,
    scope: discovery.scopes.join(' '),
    resource: discovery.resource,
  };
  saveOAuthSession(storage, session);

  const authorizationUrl = new URL(discovery.authorizationEndpoint);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', registration.client_id);
  authorizationUrl.searchParams.set('redirect_uri', cleanRedirectUri);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', pkce.challenge);
  authorizationUrl.searchParams.set('code_challenge_method', pkce.method);
  authorizationUrl.searchParams.set('scope', discovery.scopes.join(' '));
  authorizationUrl.searchParams.set('resource', discovery.resource);

  return {
    authorizationUrl: authorizationUrl.toString(),
    session,
  };
}

function assertSessionShape(session) {
  if (
    !session
    || typeof session !== 'object'
    || !Number.isFinite(session.createdAt)
    || typeof session.state !== 'string'
    || typeof session.codeVerifier !== 'string'
    || typeof session.workspaceOrigin !== 'string'
    || typeof session.mcpUrl !== 'string'
    || typeof session.issuer !== 'string'
    || typeof session.authorizationEndpoint !== 'string'
    || typeof session.tokenEndpoint !== 'string'
    || typeof session.clientId !== 'string'
    || typeof session.redirectUri !== 'string'
    || typeof session.scope !== 'string'
    || typeof session.resource !== 'string'
  ) {
    throw new InstallerError(
      'OAUTH_SESSION_INVALID',
      'The saved sign-in attempt is incomplete. Start the connection again.',
    );
  }
}

export async function finishOAuthConnection({
  callbackUrl,
  storage,
  fetchImpl = fetch,
  now = Date.now(),
}) {
  const callback = new URL(callbackUrl);
  const stored = loadOAuthSession(storage);
  if (!stored) {
    clearOAuthSession(storage);
    throw new InstallerError(
      'OAUTH_SESSION_MISSING',
      'No sign-in attempt was found. Start the connection from this installer again.',
    );
  }
  try {
    assertSessionShape(stored);
    if (now - stored.createdAt < 0 || now - stored.createdAt > OAUTH_TTL_MS) {
      throw new InstallerError(
        'OAUTH_SESSION_EXPIRED',
        'This sign-in attempt expired. Start the connection again.',
      );
    }

    const expectedCallback = new URL(stored.redirectUri);
    if (
      callback.origin !== expectedCallback.origin
      || callback.pathname !== expectedCallback.pathname
      || [...callback.searchParams].length === 0
    ) {
      throw new InstallerError(
        'OAUTH_CALLBACK_MISMATCH',
        'The sign-in response did not return to the installer callback.',
      );
    }
    if (callback.searchParams.get('state') !== stored.state) {
      throw new InstallerError(
        'OAUTH_STATE_MISMATCH',
        'The sign-in response did not match this installer session.',
      );
    }
    if (callback.searchParams.get('error')) {
      throw new InstallerError(
        'OAUTH_CANCELLED',
        'The n8n connection was cancelled or denied. No workflow was created.',
      );
    }
    const returnedIssuer = callback.searchParams.get('iss');
    if (
      returnedIssuer !== stored.issuer
      && returnedIssuer !== stored.issuer.replace(/\/$/u, '')
    ) {
      throw new InstallerError(
        'OAUTH_ISSUER_MISMATCH',
        'The sign-in response named a different authorization server.',
      );
    }
    const code = callback.searchParams.get('code');
    if (typeof code !== 'string' || !code) {
      throw new InstallerError(
        'OAUTH_CODE_MISSING',
        'The sign-in response did not include an authorization code.',
      );
    }

    const tokenUrl = assertSameOriginUrl(stored.tokenEndpoint, stored.workspaceOrigin, 'Token endpoint');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: stored.redirectUri,
      client_id: stored.clientId,
      code_verifier: stored.codeVerifier,
      resource: stored.resource,
    });
    const response = await requestUrl(tokenUrl, fetchImpl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new InstallerError(
        'OAUTH_TOKEN_FAILED',
        `n8n rejected the sign-in token exchange with HTTP ${response.status}.`,
      );
    }
    const token = await readJson(response, 'OAuth token exchange');
    if (
      typeof token.access_token !== 'string'
      || !token.access_token
      || String(token.token_type ?? '').toLowerCase() !== 'bearer'
    ) {
      throw new InstallerError(
        'OAUTH_TOKEN_INVALID',
        'n8n returned an invalid OAuth access token.',
      );
    }
    if (token.resource && token.resource !== stored.resource) {
      throw new InstallerError(
        'OAUTH_RESOURCE_MISMATCH',
        'The access token was issued for a different resource.',
      );
    }

    const workspace = parseWorkspaceUrl(stored.workspaceOrigin);
    return {
      accessToken: token.access_token,
      tokenType: 'Bearer',
      expiresAt: Number.isFinite(Number(token.expires_in))
        ? now + Number(token.expires_in) * 1000
        : null,
      scope: typeof token.scope === 'string' ? token.scope : stored.scope,
      workspace,
      mcpUrl: stored.mcpUrl,
    };
  } finally {
    clearOAuthSession(storage);
  }
}
