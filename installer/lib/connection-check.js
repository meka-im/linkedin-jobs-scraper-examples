import { InstallerError } from './errors.js';
import {
  APIFY_CREDENTIAL_TYPE,
  GOOGLE_CREDENTIAL_TYPE,
  chooseCredential,
  listCredentialCandidates,
} from './credentials.js';
import { normalizedExecutionOptions } from './node-options.js';
import {
  createWorkflowVersionFingerprint,
  readWorkflowVersionId,
} from './workflow-fingerprint.js';
import { parseWorkspaceUrl } from './workspace.js';

export const CONNECTION_CHECK_SUMMARY_NODE = 'Connection Check Summary';
export const CONNECTION_CHECK_TEMPLATE_VERSION = '2';
export const CONNECTION_CHECK_TTL_MS = 10 * 60 * 1000;
export const CONNECTION_CHECK_NODE_NAMES = Object.freeze([
  'Manual Trigger',
  'Check Apify OAuth',
  'Assess Apify Connection',
  'Check Google OAuth',
  'Assess Google Connection',
  CONNECTION_CHECK_SUMMARY_NODE,
]);

const REQUIRED_TOOLS = Object.freeze([
  'list_credentials',
  'validate_workflow',
  'create_workflow_from_code',
  'get_workflow_details',
  'execute_workflow',
  'get_workflow_execution',
]);
const WORKFLOW_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const EXECUTION_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const NONCE = /^[A-Z0-9]{8}$/u;
const TERMINAL_FAILURES = new Set([
  'error',
  'crashed',
  'canceled',
  'cancelled',
  'failed',
]);
const TERMINAL_CHECK_PHASES = new Set([
  'complete',
  'execution-failed',
  'execute-rejected',
  'pinned-or-mismatched-evidence',
  'invalid-summary',
  'workflow-version-changed',
]);
const SERVICE_STATUSES = new Set([
  'ok',
  'authorization-failed',
  'not-connected',
  'rate-limited',
  'temporary-unavailable',
  'blocked',
  'invalid-response',
]);
const REAUTH_STATUSES = new Set([
  'authorization-failed',
  'not-connected',
]);

function executionUrl(check) {
  if (
    !check?.workspaceOrigin
    || !WORKFLOW_ID.test(check.workflowId ?? '')
    || !EXECUTION_ID.test(check.executionId ?? '')
  ) {
    return null;
  }
  return `${check.workspaceOrigin}/workflow/${encodeURIComponent(check.workflowId)}/executions/${encodeURIComponent(check.executionId)}`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function jsString(value) {
  return JSON.stringify(value)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

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

function readbackWorkflow(payload) {
  if (payload?.workflow && typeof payload.workflow === 'object') return payload.workflow;
  if (payload?.workflowId && Array.isArray(payload.nodes)) return payload;
  if (payload?.id && Array.isArray(payload.nodes)) return payload;
  throw new InstallerError(
    'CONNECTION_CHECK_READBACK_INVALID',
    'n8n returned no account-check workflow to verify.',
  );
}

export function renderConnectionResponseStatusCode(label) {
  return `const response = $input.first()?.json ?? {};

function responseCode(value) {
  const code = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
}

function parseMessageJson(value) {
  if (typeof value !== 'string') return { statusCode: null, body: null };
  const message = value.trim();
  const match = /^(?:HTTP\\s*)?([45]\\d{2})\\s*-\\s*(?:JSON\\s*:\\s*)?([\\s\\S]+)$/i.exec(message);
  if (!match || match[2].length > 65536) return { statusCode: null, body: null };
  try {
    return { statusCode: Number(match[1]), body: JSON.parse(match[2]) };
  } catch {
    return { statusCode: Number(match[1]), body: null };
  }
}

function parseBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function addRateReasons(reasons, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const error = body.error && typeof body.error === 'object' ? body.error : body;
  for (const collection of [error?.errors, error?.details]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection.slice(0, 20)) {
      if (!item || typeof item !== 'object') continue;
      const reason = typeof item.reason === 'string' ? item.reason.trim().toLowerCase() : '';
      if (reason) reasons.add(reason);
    }
  }
}

const messages = [
  response.error?.message,
  response.error?.description,
  response.error?.cause?.message,
  response.message,
].filter((value) => typeof value === 'string');
const parsedMessages = messages.map(parseMessageJson);

let statusCode = responseCode(response.statusCode)
  ?? responseCode(response.response?.statusCode)
  ?? responseCode(response.response?.status)
  ?? responseCode(response.error?.httpCode)
  ?? responseCode(response.error?.statusCode);
for (const parsed of parsedMessages) {
  if (statusCode == null) statusCode = parsed.statusCode;
}

const bodies = [
  parseBody(response.body),
  parseBody(response.response?.body),
  parseBody(response.error?.response?.body),
  parseBody(response.error?.body),
  ...parsedMessages.map((parsed) => parseBody(parsed.body)),
].filter(Boolean);
if (bodies.length === 0 && response.error && typeof response.error === 'object') {
  bodies.push(response.error);
}
for (const body of bodies) {
  if (statusCode == null) {
    statusCode = responseCode(body?.error?.code)
      ?? responseCode(body?.error?.statusCode)
      ?? responseCode(body?.code);
  }
}

const rateReasons = new Set();
for (const body of bodies) addRateReasons(rateReasons, body);
const rateLimited = statusCode === 429 || (
  statusCode === 403
  && [...rateReasons].some((reason) => [
    'ratelimitexceeded',
    'userratelimitexceeded',
    'quotaexceeded',
    'rate_limit_exceeded',
  ].includes(reason))
);
const credentialsMissing = messages.some((message) => {
  const normalized = message.trim();
  return /^Credentials not found\\.?$/i.test(normalized)
    || normalized === 'Unable to sign without access token';
});

let status;
let httpStatus = null;
if (Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300) {
  status = 'ok';
} else if (rateLimited) {
  status = 'rate-limited';
  httpStatus = statusCode;
} else if (statusCode === 401 || statusCode === 403) {
  status = 'authorization-failed';
  httpStatus = statusCode;
} else if (Number.isInteger(statusCode) && statusCode >= 500 && statusCode < 600) {
  status = 'temporary-unavailable';
  httpStatus = statusCode;
} else if (statusCode == null && credentialsMissing) {
  status = 'not-connected';
} else {
  status = 'blocked';
}
return [{ json: { service: ${jsString(label)}, status, httpStatus } }];
`;
}

function connectionSummaryCode() {
  return `const apify = $('Assess Apify Connection').first()?.json ?? {};
const google = $('Assess Google Connection').first()?.json ?? {};
const checked = apify.status === 'ok' && google.status === 'ok';
return [{
  json: {
    workflowId: String($workflow?.id ?? ''),
    executionId: String($execution?.id ?? ''),
    status: checked ? 'checked' : 'failed',
    apifyStatus: typeof apify.status === 'string' ? apify.status : 'invalid-response',
    googleStatus: typeof google.status === 'string' ? google.status : 'invalid-response'
  }
}];
`;
}

export function makeConnectionCheckIdentity(baseName, nonce) {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) {
    throw new InstallerError(
      'CONNECTION_CHECK_NONCE_INVALID',
      'The account-check marker is invalid.',
    );
  }
  const base = typeof baseName === 'string' && baseName.trim()
    ? baseName.trim()
    : 'MEKA account check';
  const suffix = ` · ${nonce}`;
  const name = `${base.slice(0, 128 - suffix.length).trim()}${suffix}`;
  return Object.freeze({
    name,
    nonce,
    description: `Created by the MEKA installer ${nonce} for read-only account checks.`,
  });
}

export function renderConnectionCheckCode({
  identity,
  apifyCredential,
  googleCredential,
}) {
  if (!identity?.name || !NONCE.test(identity.nonce ?? '')) {
    throw new InstallerError(
      'CONNECTION_CHECK_IDENTITY_INVALID',
      'The account-check workflow identity is invalid.',
    );
  }
  if (
    apifyCredential?.type !== APIFY_CREDENTIAL_TYPE
    || typeof apifyCredential.id !== 'string'
    || !WORKFLOW_ID.test(apifyCredential.id)
    || googleCredential?.type !== GOOGLE_CREDENTIAL_TYPE
    || typeof googleCredential.id !== 'string'
    || !WORKFLOW_ID.test(googleCredential.id)
  ) {
    throw new InstallerError(
      'CONNECTION_CHECK_CREDENTIAL_INVALID',
      'The selected account-check credentials are invalid.',
    );
  }

  return `import { newCredential, node, trigger, workflow } from '@n8n/workflow-sdk';

const manual_Trigger = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { id: 'c7bb4317-b4f2-4ef7-9629-e0671d4ccf01', name: 'Manual Trigger', position: [-720, 0] }
});

const check_Apify = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    id: '2b9697c1-6356-48b9-88b4-f42830563b0b',
    name: 'Check Apify OAuth',
    parameters: {
      method: 'GET',
      url: 'https://api.apify.com/v2/users/me',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'apifyOAuth2Api',
      options: {
        response: {
          response: {
            fullResponse: true,
            responseFormat: 'json',
            neverError: true
          }
        },
        timeout: 15000
      }
    },
    credentials: {
      apifyOAuth2Api: newCredential(${jsString(apifyCredential.name)}, ${jsString(apifyCredential.id)})
    },
    position: [-480, 0],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    retryOnFail: false
  }
});

const assess_Apify = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    id: '16cfa94d-5d5d-4681-b57c-037e9a7ad8e6',
    name: 'Assess Apify Connection',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: ${jsString(renderConnectionResponseStatusCode('apify'))}
    },
    position: [-240, 0]
  }
});

const check_Google = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    id: '8fb3b2f0-1937-4731-9d13-1b9c42daf821',
    name: 'Check Google OAuth',
    parameters: {
      method: 'GET',
      url: 'https://www.googleapis.com/drive/v3/files?fields=files(id)&pageSize=1',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleSheetsOAuth2Api',
      options: {
        response: {
          response: {
            fullResponse: true,
            responseFormat: 'json',
            neverError: true
          }
        },
        timeout: 15000
      }
    },
    credentials: {
      googleSheetsOAuth2Api: newCredential(${jsString(googleCredential.name)}, ${jsString(googleCredential.id)})
    },
    position: [0, 0],
    alwaysOutputData: true,
    onError: 'continueRegularOutput',
    retryOnFail: false
  }
});

const assess_Google = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    id: '43c1b775-32e0-4c13-9b99-5b87c8c34499',
    name: 'Assess Google Connection',
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: ${jsString(renderConnectionResponseStatusCode('google'))}
    },
    position: [240, 0]
  }
});

const connection_Check_Summary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    id: 'dc6f2612-741d-48f0-98d0-1de99080fa71',
    name: ${jsString(CONNECTION_CHECK_SUMMARY_NODE)},
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: ${jsString(connectionSummaryCode())}
    },
    position: [480, 0]
  }
});

export default workflow('', ${jsString(identity.name)}, {
  executionOrder: 'v1',
  timezone: 'UTC'
})
  .add(manual_Trigger)
  .to(check_Apify)
  .to(assess_Apify)
  .to(check_Google)
  .to(assess_Google)
  .to(connection_Check_Summary);
`;
}

export async function verifyConnectionCheckWorkflow({
  details,
  workflowId,
  workflowName,
  workspaceOrigin,
  apifyCredentialId,
  googleCredentialId,
  apifyCredentialName,
  googleCredentialName,
}) {
  const workflow = readbackWorkflow(details);
  if (workflow.id !== workflowId && details?.workflowId !== workflowId) {
    throw new InstallerError(
      'CONNECTION_CHECK_ID_MISMATCH',
      'n8n returned a different account-check workflow.',
    );
  }
  if (workflow.name !== workflowName) {
    throw new InstallerError(
      'CONNECTION_CHECK_NAME_MISMATCH',
      'The account-check workflow name did not match the request.',
    );
  }
  if (workflow.active !== false) {
    throw new InstallerError(
      'CONNECTION_CHECK_ACTIVE',
      'The account-check workflow is active. The installer will not execute it.',
    );
  }
  const expectedNodes = [
    {
      id: 'c7bb4317-b4f2-4ef7-9629-e0671d4ccf01',
      name: 'Manual Trigger',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      parameters: {},
      position: [-720, 0],
    },
    {
      id: '2b9697c1-6356-48b9-88b4-f42830563b0b',
      name: 'Check Apify OAuth',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      parameters: {
        method: 'GET',
        url: 'https://api.apify.com/v2/users/me',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: APIFY_CREDENTIAL_TYPE,
        options: {
          response: {
            response: {
              fullResponse: true,
              responseFormat: 'json',
              neverError: true,
            },
          },
          timeout: 15000,
        },
      },
      credentials: APIFY_CREDENTIAL_TYPE,
      position: [-480, 0],
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
      retryOnFail: false,
    },
    {
      id: '16cfa94d-5d5d-4681-b57c-037e9a7ad8e6',
      name: 'Assess Apify Connection',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: renderConnectionResponseStatusCode('apify'),
      },
      position: [-240, 0],
    },
    {
      id: '8fb3b2f0-1937-4731-9d13-1b9c42daf821',
      name: 'Check Google OAuth',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      parameters: {
        method: 'GET',
        url: 'https://www.googleapis.com/drive/v3/files?fields=files(id)&pageSize=1',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: GOOGLE_CREDENTIAL_TYPE,
        options: {
          response: {
            response: {
              fullResponse: true,
              responseFormat: 'json',
              neverError: true,
            },
          },
          timeout: 15000,
        },
      },
      credentials: GOOGLE_CREDENTIAL_TYPE,
      position: [0, 0],
      alwaysOutputData: true,
      onError: 'continueRegularOutput',
      retryOnFail: false,
    },
    {
      id: '43c1b775-32e0-4c13-9b99-5b87c8c34499',
      name: 'Assess Google Connection',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: renderConnectionResponseStatusCode('google'),
      },
      position: [240, 0],
    },
    {
      id: 'dc6f2612-741d-48f0-98d0-1de99080fa71',
      name: CONNECTION_CHECK_SUMMARY_NODE,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: connectionSummaryCode(),
      },
      position: [480, 0],
    },
  ];
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length !== expectedNodes.length) {
    throw new InstallerError(
      'CONNECTION_CHECK_GRAPH_MISMATCH',
      'The account-check workflow has an unexpected graph.',
    );
  }
  const nodes = new Map(workflow.nodes.map((item) => [item?.name, item]));
  if (nodes.size !== expectedNodes.length) {
    throw new InstallerError(
      'CONNECTION_CHECK_GRAPH_MISMATCH',
      'The account-check workflow has duplicate or unnamed nodes.',
    );
  }
  for (const expected of expectedNodes) {
    const found = nodes.get(expected.name);
    if (
      !found
      || found.id !== expected.id
      || found.type !== expected.type
      || found.typeVersion !== expected.typeVersion
      || !sameJson(found.parameters, expected.parameters)
      || !sameJson(found.position, expected.position)
      || !sameJson(
        normalizedExecutionOptions(found),
        normalizedExecutionOptions(expected),
      )
    ) {
      throw new InstallerError(
        'CONNECTION_CHECK_GRAPH_MISMATCH',
        `The account-check node “${expected.name}” does not match the reviewed graph.`,
      );
    }
  }
  const expectedConnections = {
    'Manual Trigger': {
      main: [[{ node: 'Check Apify OAuth', type: 'main', index: 0 }]],
    },
    'Check Apify OAuth': {
      main: [[{ node: 'Assess Apify Connection', type: 'main', index: 0 }]],
    },
    'Assess Apify Connection': {
      main: [[{ node: 'Check Google OAuth', type: 'main', index: 0 }]],
    },
    'Check Google OAuth': {
      main: [[{ node: 'Assess Google Connection', type: 'main', index: 0 }]],
    },
    'Assess Google Connection': {
      main: [[{ node: CONNECTION_CHECK_SUMMARY_NODE, type: 'main', index: 0 }]],
    },
  };
  if (!sameJson(workflow.connections, expectedConnections)) {
    throw new InstallerError(
      'CONNECTION_CHECK_GRAPH_MISMATCH',
      'The account-check connection graph does not match the reviewed workflow.',
    );
  }
  const workflowSettings = workflow.settings ?? {};
  if (
    workflowSettings.executionOrder !== 'v1'
    || workflowSettings.timezone !== 'UTC'
    || workflowSettings.availableInMCP !== true
  ) {
    throw new InstallerError(
      'CONNECTION_CHECK_SETTINGS_MISMATCH',
      'The account-check workflow settings do not match the reviewed inactive workflow.',
    );
  }

  if (
    typeof apifyCredentialId !== 'string'
    || !WORKFLOW_ID.test(apifyCredentialId)
    || typeof apifyCredentialName !== 'string'
    || !apifyCredentialName.trim()
    || apifyCredentialName.length > 128
    || typeof googleCredentialId !== 'string'
    || !WORKFLOW_ID.test(googleCredentialId)
    || typeof googleCredentialName !== 'string'
    || !googleCredentialName.trim()
    || googleCredentialName.length > 128
  ) {
    throw new InstallerError(
      'CONNECTION_CHECK_CREDENTIAL_INVALID',
      'The account-check evidence cannot be bound to valid credential IDs.',
    );
  }
  let exposedCredentials = 0;
  let missingCredentials = 0;
  for (const expected of expectedNodes.filter((node) => node.credentials)) {
    const found = nodes.get(expected.name);
    if (!Object.hasOwn(found, 'credentials')) {
      missingCredentials += 1;
      continue;
    }
    exposedCredentials += 1;
    const credentials = found.credentials;
    if (
      !credentials
      || typeof credentials !== 'object'
      || Array.isArray(credentials)
      || Object.keys(credentials).length !== 1
      || !Object.hasOwn(credentials, expected.credentials)
    ) {
      throw new InstallerError(
        'CONNECTION_CHECK_CREDENTIAL_MISMATCH',
        `The account-check node “${expected.name}” has an unexpected credential type.`,
      );
    }
    const expectedId = expected.credentials === APIFY_CREDENTIAL_TYPE
      ? apifyCredentialId
      : googleCredentialId;
    const expectedName = expected.credentials === APIFY_CREDENTIAL_TYPE
      ? apifyCredentialName
      : googleCredentialName;
    const reference = credentials[expected.credentials];
    if (
      !reference
      || typeof reference !== 'object'
      || Array.isArray(reference)
      || !sameJson(Object.keys(reference).sort(), ['id', 'name'])
      || reference.id !== expectedId
      || reference.name !== expectedName
    ) {
      throw new InstallerError(
        'CONNECTION_CHECK_CREDENTIAL_MISMATCH',
        `The account-check node “${expected.name}” is not bound to the exact checked credential.`,
      );
    }
  }
  if (exposedCredentials > 0 && missingCredentials > 0) {
    throw new InstallerError(
      'CONNECTION_CHECK_CREDENTIAL_PARTIAL',
      'n8n exposed only part of the account-check credential references.',
    );
  }
  const workflowVersionFingerprint = await createWorkflowVersionFingerprint(details);
  return {
    workflowId,
    workflowName,
    workflowVersionFingerprint,
    workflowVersionId: readWorkflowVersionId(details),
    openUrl: `${parseWorkspaceUrl(workspaceOrigin).origin}/workflow/${encodeURIComponent(workflowId)}`,
    credentialReferenceReadback: exposedCredentials === 2 ? 'verified' : 'not-exposed',
    credentialReferenceCount: exposedCredentials,
    templateVersion: CONNECTION_CHECK_TEMPLATE_VERSION,
  };
}

function executionRecord(payload) {
  const execution = payload?.execution ?? payload;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    throw new InstallerError(
      'EXECUTION_READBACK_INVALID',
      'n8n returned no execution metadata.',
    );
  }
  return {
    id: String(execution.id ?? '').trim(),
    workflowId: String(execution.workflowId ?? '').trim(),
    status: String(execution.status ?? '').trim().toLowerCase(),
    stoppedAt: execution.stoppedAt ?? null,
  };
}

function summaryRecord(payload) {
  if (payload?.summary && typeof payload.summary === 'object' && !Array.isArray(payload.summary)) {
    return payload.summary;
  }
  const runData = payload?.data?.resultData?.runData;
  const summary = runData?.[CONNECTION_CHECK_SUMMARY_NODE]?.[0]
    ?.data?.main?.[0]?.[0]?.json;
  return summary && typeof summary === 'object' && !Array.isArray(summary)
    ? summary
    : null;
}

async function pollConnectionExecution({
  client,
  workflowId,
  executionId,
  maxPolls,
  pollIntervalMs,
  wait,
}) {
  for (let attempt = 0; attempt < maxPolls; attempt += 1) {
    const payload = await client.callTool('get_workflow_execution', {
      workflowId,
      executionId,
      includeData: false,
    });
    const execution = executionRecord(payload);
    if (execution.id !== executionId || execution.workflowId !== workflowId) {
      throw new InstallerError(
        'EXECUTION_ID_MISMATCH',
        'n8n returned a different execution than the one started by this installer.',
      );
    }
    if (TERMINAL_FAILURES.has(execution.status)) {
      return { execution, summary: null, outcome: 'failed' };
    }
    if (execution.status === 'success' && execution.stoppedAt) return {
      execution,
      summary: null,
      outcome: 'success',
    };
    if (attempt + 1 < maxPolls) {
      await wait(pollIntervalMs);
    }
  }
  return null;
}

function connectionEvidence({
  workspaceOrigin,
  workflowId,
  workflowVersionId,
  workflowVersionFingerprint,
  executionId,
  apifyCredentialId,
  googleCredentialId,
  apifyStatus,
  googleStatus,
  checkedAt,
  credentialReferenceReadback,
}) {
  return Object.freeze({
    version: 1,
    workspaceOrigin,
    workflowId,
    workflowVersionId,
    workflowVersionFingerprint,
    executionId,
    apifyCredentialId,
    googleCredentialId,
    apifyStatus,
    googleStatus,
    checkedAt,
    credentialReferenceReadback,
  });
}

export function connectionEvidenceIsCurrent(
  evidence,
  {
    workspaceOrigin,
    apifyCredentialId,
    googleCredentialId,
    now = Date.now(),
  },
) {
  const checkedAt = Date.parse(evidence?.checkedAt ?? '');
  return Boolean(
    evidence?.version === 1
    && evidence.workspaceOrigin === workspaceOrigin
    && WORKFLOW_ID.test(evidence.workflowId ?? '')
    && EXECUTION_ID.test(evidence.executionId ?? '')
    && WORKFLOW_ID.test(evidence.workflowVersionId ?? '')
    && /^[0-9a-f]{64}$/u.test(evidence.workflowVersionFingerprint ?? '')
    && evidence.apifyCredentialId === apifyCredentialId
    && evidence.googleCredentialId === googleCredentialId
    && evidence.apifyStatus === 'ok'
    && evidence.googleStatus === 'ok'
    && Number.isFinite(checkedAt)
    && now >= checkedAt
    && now - checkedAt <= CONNECTION_CHECK_TTL_MS,
  );
}

export function canResetTerminalConnectionCheckAttempt(check) {
  return Boolean(
    check?.createAttempted === true
    && WORKFLOW_ID.test(check.workflowId ?? '')
    && ['failed', 'checked'].includes(check.status)
    && TERMINAL_CHECK_PHASES.has(check.phase)
    && !(
      check.executionRequested === true
      && !EXECUTION_ID.test(check.executionId ?? '')
      && check.phase !== 'execute-rejected'
    ),
  );
}

export function connectionCheckRequiresHelperReset(check) {
  return (
    canResetTerminalConnectionCheckAttempt(check)
    && check.templateVersion !== CONNECTION_CHECK_TEMPLATE_VERSION
  );
}

export function resetTerminalConnectionCheckAttempt(
  state,
  { now = Date.now() } = {},
) {
  const check = state?.connectionCheck;
  if (!canResetTerminalConnectionCheckAttempt(check)) {
    throw new InstallerError(
      'CONNECTION_CHECK_RESET_NOT_ALLOWED',
      'This account check is not in a known terminal state. Inspect its latest execution in n8n before replacing it.',
      {
        safeDetails: {
          workflowUrl: check?.openUrl ?? null,
          executionUrl: executionUrl(check),
        },
      },
    );
  }
  check.resetAttempt = {
    previousWorkflowId: check.workflowId,
    previousExecutionId: EXECUTION_ID.test(check.executionId ?? '')
      ? check.executionId
      : null,
    previousOpenUrl: check.openUrl,
    previousTemplateVersion: check.templateVersion ?? null,
    resetAt: new Date(now).toISOString(),
  };
  check.status = 'not-checked';
  check.phase = 'helper-reset';
  check.identity = null;
  check.createAttempted = false;
  check.executionRequested = false;
  check.executionId = null;
  check.executionRequestedAt = null;
  check.workflowId = null;
  check.workflowVersionId = null;
  check.workflowVersionFingerprint = null;
  check.templateVersion = null;
  check.openUrl = null;
  check.evidence = null;
  check.apifyStatus = null;
  check.googleStatus = null;
  check.checkedAt = null;
  check.invalidationReason = 'helper-template-reset';
  return check;
}

export async function runConnectionCheck({
  client,
  workspaceOrigin,
  apifyCredentialId,
  googleCredentialId,
  nonce,
  state = {},
  onStateChange = () => {},
  now = Date.now(),
  wait = sleep,
  pollIntervalMs = 2_000,
  maxPolls = 30,
  verifyWorkflow = verifyConnectionCheckWorkflow,
}) {
  if (
    !client
    || typeof client.callTool !== 'function'
    || typeof client.requireTools !== 'function'
  ) {
    throw new InstallerError(
      'MCP_CLIENT_INVALID',
      'The MCP client is unavailable.',
    );
  }
  client.requireTools(REQUIRED_TOOLS);
  const workspace = parseWorkspaceUrl(workspaceOrigin);
  const apifyCandidates = await listCredentialCandidates(client, APIFY_CREDENTIAL_TYPE);
  const googleCandidates = await listCredentialCandidates(client, GOOGLE_CREDENTIAL_TYPE);
  const apify = chooseCredential(
    apifyCandidates,
    apifyCredentialId,
    'Apify OAuth',
    APIFY_CREDENTIAL_TYPE,
  );
  const google = chooseCredential(
    googleCandidates,
    googleCredentialId,
    'Google Sheets OAuth',
    GOOGLE_CREDENTIAL_TYPE,
  );

  const existing = state.connectionCheck;
  const preserveWorkflowStatus = Boolean(
    state.createAttempted === true
    && typeof state.workflowId === 'string'
    && state.workflowId,
  );
  const sameBinding = (
    existing?.workspaceOrigin === workspace.origin
    && existing?.apifyCredentialId === apify.id
    && existing?.googleCredentialId === google.id
  );
  let existingWorkspace = null;
  try {
    existingWorkspace = parseWorkspaceUrl(existing?.workspaceOrigin);
  } catch {
    existingWorkspace = null;
  }
  const existingWorkflowUrl = existing?.workflowId
    ? `${existingWorkspace?.origin ?? workspace.origin}/workflow/${encodeURIComponent(existing.workflowId)}`
    : existingWorkspace
      ? `${existingWorkspace.origin}/home/workflows`
      : null;
  if (
    existing?.executionRequested === true
    && !existing?.executionId
    && !(
      existing?.status === 'failed'
      && existing?.phase === 'execute-rejected'
    )
  ) {
    throw new InstallerError(
      'CHECK_EXECUTION_UNKNOWN',
      'The account-check execution outcome is unknown. Open the check workflow in n8n and inspect its latest execution before trying again.',
      {
        safeDetails: {
          workflowUrl: existingWorkflowUrl,
        },
      },
    );
  }

  const resumedExecutionStatus = (
    existing?.executionRequested === true
    && typeof existing?.executionId === 'string'
    && !['checked', 'failed'].includes(existing?.status)
  );
  const resumeRecordedExecution = Boolean(
    sameBinding
    && resumedExecutionStatus
    && existing?.workflowId
  );
  if (resumedExecutionStatus && !resumeRecordedExecution) {
    throw new InstallerError(
      'CHECK_BINDING_CHANGED_UNKNOWN',
      'The account-check execution is still unresolved and belongs to different credential selections. Open the recorded check workflow and execution in n8n before starting another check.',
      {
        safeDetails: {
          workflowUrl: existingWorkflowUrl,
          previousApifyCredentialId: existing?.apifyCredentialId ?? null,
          previousGoogleCredentialId: existing?.googleCredentialId ?? null,
        },
      },
    );
  }
  if (
    sameBinding
    && connectionCheckRequiresHelperReset(existing)
  ) {
    throw new InstallerError(
      'CHECK_HELPER_RESET_REQUIRED',
      'This completed account check used an older helper workflow and cannot be reused with the current verification. Reset the completed account check to create a new helper.',
      {
        safeDetails: {
          workflowUrl: existingWorkflowUrl,
          executionUrl: executionUrl({
            workspaceOrigin: workspace.origin,
            workflowId: existing?.workflowId,
            executionId: existing?.executionId,
          }),
        },
      },
    );
  }
  const unresolvedCreation = Boolean(
    existing?.createAttempted === true
    && existing?.executionRequested !== true
    && ['checking', 'unknown'].includes(existing?.status),
  );
  if (unresolvedCreation && !sameBinding) {
    throw new InstallerError(
      'CHECK_BINDING_CHANGED_UNKNOWN',
      'An earlier account-check workflow creation is unresolved and belongs to different credential selections. Open the recorded check workflow in n8n before starting another check.',
      {
        safeDetails: {
          workflowUrl: existingWorkflowUrl,
          previousApifyCredentialId: existing?.apifyCredentialId ?? null,
          previousGoogleCredentialId: existing?.googleCredentialId ?? null,
        },
      },
    );
  }
  if (preserveWorkflowStatus) {
    if (['not-checked', 'checking', 'checked'].includes(state.status)) {
      state.status = 'installed-pending-test';
    }
  } else {
    state.status = 'checking';
  }
  state.workspaceOrigin = workspace.origin;
  if (resumeRecordedExecution) {
    existing.status = 'checking';
    existing.phase = 'resume-recorded-execution';
    state.connectionCheck = existing;
    onStateChange(state);
    return finishConnectionCheck({
      client,
      state,
      check: existing,
      workspace,
      maxPolls,
      pollIntervalMs,
      wait,
      now,
      preserveWorkflowStatus,
      verifyWorkflow,
      onStateChange,
    });
  }

  const previousEvidenceStale = sameBinding && existing
    ? {
      createAttempted: existing.createAttempted === true,
      workflowId: existing.workflowId,
      openUrl: existing.openUrl,
    }
    : {
      createAttempted: false,
      workflowId: null,
      openUrl: null,
    };

  const identity = sameBinding && existing?.identity
    ? existing.identity
    : makeConnectionCheckIdentity('MEKA account check', nonce);
  const check = {
    status: 'checking',
    phase: 'new',
    identity,
    workspaceOrigin: workspace.origin,
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    apifyCredentialName: apify.name,
    googleCredentialName: google.name,
    createAttempted: previousEvidenceStale.createAttempted,
    executionRequested: false,
    executionId: null,
    workflowId: previousEvidenceStale.workflowId,
    openUrl: previousEvidenceStale.openUrl,
    evidence: null,
    apifyStatus: null,
    googleStatus: null,
    checkedAt: null,
    workflowVersionId: null,
    workflowVersionFingerprint: null,
    templateVersion: null,
    resetAttempt: sameBinding && existing?.resetAttempt
      ? existing.resetAttempt
      : null,
  };
  state.connectionCheck = check;
  onStateChange(state);

  let verified;
  if (check.workflowId && WORKFLOW_ID.test(check.workflowId)) {
    const details = await client.callTool('get_workflow_details', {
      workflowId: check.workflowId,
    });
    verified = await verifyWorkflow({
      details,
      workflowId: check.workflowId,
      workflowName: identity.name,
      workspaceOrigin: workspace.origin,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      apifyCredentialName: apify.name,
      googleCredentialName: google.name,
    });
  } else if (check.createAttempted) {
    client.requireTools(['search_workflows']);
    const result = await client.callTool('search_workflows', {
      query: identity.name,
      limit: 20,
    });
    const workflows = Array.isArray(result?.workflows)
      ? result.workflows
      : Array.isArray(result?.data)
        ? result.data
        : [];
    const matches = workflows.filter((item) => item?.name === identity.name);
    if (matches.length !== 1 || !WORKFLOW_ID.test(matches[0]?.id ?? '')) {
      check.status = 'unknown';
      if (!preserveWorkflowStatus) state.status = 'unknown';
      onStateChange(state);
      throw new InstallerError(
        matches.length === 0 ? 'CHECK_WORKFLOW_NOT_FOUND' : 'CHECK_WORKFLOW_AMBIGUOUS',
        'The installer could not uniquely find the account-check workflow. Do not create another one; inspect n8n first.',
      );
    }
    check.workflowId = matches[0].id;
    const details = await client.callTool('get_workflow_details', {
      workflowId: check.workflowId,
    });
    verified = await verifyWorkflow({
      details,
      workflowId: check.workflowId,
      workflowName: identity.name,
      workspaceOrigin: workspace.origin,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      apifyCredentialName: apify.name,
      googleCredentialName: google.name,
    });
  } else {
    const code = renderConnectionCheckCode({
      identity,
      apifyCredential: apify,
      googleCredential: google,
    });
    const validation = await client.callTool('validate_workflow', { code });
    if (validation?.valid !== true) {
      throw new InstallerError(
        'CHECK_WORKFLOW_VALIDATION_FAILED',
        'n8n rejected the read-only account-check workflow. No workflow was created.',
      );
    }
    check.createAttempted = true;
    check.phase = 'create-requested';
    onStateChange(state);
    let created;
    try {
      created = await client.callTool('create_workflow_from_code', {
        code,
        name: identity.name,
        description: identity.description,
        versionName: 'MEKA account check v1',
        versionDescription: 'Inactive read-only Apify and Google account checks.',
      });
    } catch (error) {
      check.status = 'unknown';
      if (!preserveWorkflowStatus) state.status = 'unknown';
      onStateChange(state);
      throw new InstallerError(
        'CHECK_CREATE_RESULT_UNKNOWN',
        'The account-check create request ended without a reliable result. Reconnect and check the uniquely named workflow before trying again.',
        { cause: error },
      );
    }
    if (
      !created
      || !WORKFLOW_ID.test(created.workflowId ?? '')
      || typeof created.url !== 'string'
    ) {
      check.status = 'unknown';
      if (!preserveWorkflowStatus) state.status = 'unknown';
      onStateChange(state);
      throw new InstallerError(
        'CHECK_CREATE_RESULT_UNKNOWN',
        'n8n did not return a complete account-check result. Inspect the unique workflow before trying again.',
      );
    }
    let createdUrl;
    try {
      createdUrl = new URL(created.url);
    } catch {
      throw new InstallerError(
        'CHECK_CREATE_RESULT_INVALID',
        'n8n returned an invalid account-check workflow URL.',
      );
    }
    if (
      createdUrl.origin !== workspace.origin
      || createdUrl.pathname !== `/workflow/${created.workflowId}`
    ) {
      throw new InstallerError(
        'CHECK_CREATE_RESULT_INVALID',
        'n8n returned an account-check workflow outside the selected workspace.',
      );
    }
    check.workflowId = created.workflowId;
    const details = await client.callTool('get_workflow_details', {
      workflowId: check.workflowId,
    });
    verified = await verifyWorkflow({
      details,
      workflowId: check.workflowId,
      workflowName: identity.name,
      workspaceOrigin: workspace.origin,
      apifyCredentialId: apify.id,
      googleCredentialId: google.id,
      apifyCredentialName: apify.name,
      googleCredentialName: google.name,
    });
  }

  check.phase = 'verified';
  check.workflowVersionId = verified.workflowVersionId;
  check.workflowVersionFingerprint = verified.workflowVersionFingerprint;
  check.templateVersion = verified.templateVersion;
  check.openUrl = verified.openUrl;
  check.executionRequested = true;
  check.executionId = null;
  check.executionRequestedAt = new Date(now).toISOString();
  onStateChange(state);

  let executed;
  try {
    executed = await client.callTool('execute_workflow', {
      workflowId: check.workflowId,
      executionMode: 'manual',
      triggerNodeName: 'Manual Trigger',
    });
  } catch (error) {
    check.status = 'unknown';
    if (!preserveWorkflowStatus) state.status = 'unknown';
    onStateChange(state);
    throw new InstallerError(
      'CHECK_EXECUTION_UNKNOWN',
      'n8n did not return a reliable account-check execution result. Do not click again; inspect the latest execution in n8n.',
      { cause: error },
    );
  }
  if (
    executed?.responsePolicy === 'execution-response-v1'
    && executed?.status === 'error'
    && executed?.executionId === null
  ) {
    check.status = 'failed';
    check.phase = 'execute-rejected';
    if (!preserveWorkflowStatus) state.status = 'failed';
    onStateChange(state);
    throw new InstallerError(
      'CHECK_EXECUTION_REJECTED',
      'n8n rejected the account-check execution. The installer did not retry. Review the check workflow and OAuth scopes.',
      { safeDetails: { workflowUrl: check.openUrl } },
    );
  }
  if (
    executed?.responsePolicy !== 'execution-response-v1'
    || executed?.status !== 'started'
    || !EXECUTION_ID.test(executed?.executionId ?? '')
  ) {
    check.status = 'unknown';
    check.phase = 'execute-outcome-unknown';
    if (!preserveWorkflowStatus) state.status = 'unknown';
    onStateChange(state);
    throw new InstallerError(
      'CHECK_EXECUTION_UNKNOWN',
      'n8n did not return a reliably completed account-check execution result. Do not click again; inspect the latest execution in n8n.',
      { safeDetails: { workflowUrl: check.openUrl } },
    );
  }
  check.executionId = executed.executionId;
  check.phase = 'executing';
  onStateChange(state);

  return finishConnectionCheck({
    client,
    state,
    check,
    workspace,
    maxPolls,
    pollIntervalMs,
    wait,
    now,
    preserveWorkflowStatus,
    verifyWorkflow,
    onStateChange,
  });
}

async function finishConnectionCheck({
  client,
  state,
  check,
  workspace,
  maxPolls,
  pollIntervalMs,
  wait,
  now,
  preserveWorkflowStatus,
  verifyWorkflow,
  onStateChange,
}) {
  const polled = await pollConnectionExecution({
    client,
    workflowId: check.workflowId,
    executionId: check.executionId,
    maxPolls,
    pollIntervalMs,
    wait,
  });
  if (!polled) {
    check.status = 'unknown';
    check.phase = 'polling-timeout';
    if (!preserveWorkflowStatus) state.status = 'unknown';
    onStateChange(state);
    throw new InstallerError(
      'CHECK_EXECUTION_UNKNOWN',
      'The account-check execution has not reached a terminal state. The installer will only resume this same execution later.',
      { safeDetails: { workflowUrl: check.openUrl } },
    );
  }
  if (polled.outcome !== 'success') {
    check.status = 'failed';
    check.phase = 'execution-failed';
    if (!preserveWorkflowStatus) state.status = 'failed';
    onStateChange(state);
    throw new InstallerError(
      'CHECK_EXECUTION_FAILED',
      'The account-check execution failed. Inspect the latest n8n execution; the installer did not restart it.',
      { safeDetails: { workflowUrl: check.openUrl } },
    );
  }

  const finalPayload = await client.callTool('get_workflow_execution', {
    workflowId: check.workflowId,
    executionId: check.executionId,
    includeData: true,
    nodeNames: [...CONNECTION_CHECK_NODE_NAMES],
    truncateData: 1,
  });
  const finalExecution = executionRecord(finalPayload);
  if (
    finalExecution.id !== check.executionId
    || finalExecution.workflowId !== check.workflowId
    || finalExecution.status !== 'success'
    || !finalExecution.stoppedAt
  ) {
    throw new InstallerError(
      'EXECUTION_READBACK_INVALID',
      'n8n did not return the successful account-check execution requested.',
    );
  }
  const summary = summaryRecord(finalPayload);
  if (
    finalPayload?.hasPinnedServiceData !== false
    || summary?.executionId !== check.executionId
    || summary?.workflowId !== check.workflowId
  ) {
    check.status = 'failed';
    check.phase = 'pinned-or-mismatched-evidence';
    if (!preserveWorkflowStatus) state.status = 'failed';
    onStateChange(state);
    throw new InstallerError(
      'CONNECTION_CHECK_PINNED_OR_MISMATCHED',
      'The account-check evidence used pinned service data or did not match this execution. No connection result was accepted.',
      { safeDetails: { workflowUrl: check.openUrl } },
    );
  }
  if (
    summary?.status !== 'checked'
    && summary?.status !== 'failed'
  ) {
    check.status = 'failed';
    check.phase = 'invalid-summary';
    if (!preserveWorkflowStatus) state.status = 'failed';
    onStateChange(state);
    throw new InstallerError(
      'CONNECTION_CHECK_SUMMARY_INVALID',
      'The account-check execution did not return a valid sanitized summary.',
      { safeDetails: { workflowUrl: check.openUrl } },
    );
  }
  const apifyStatus = typeof summary.apifyStatus === 'string'
    ? summary.apifyStatus
    : 'invalid-response';
  const googleStatus = typeof summary.googleStatus === 'string'
    ? summary.googleStatus
    : 'invalid-response';
  const bothConnected = apifyStatus === 'ok' && googleStatus === 'ok';
  if (
    (summary.status === 'checked') !== bothConnected
    || !SERVICE_STATUSES.has(apifyStatus)
    || !SERVICE_STATUSES.has(googleStatus)
  ) {
    check.status = 'failed';
    check.phase = 'invalid-summary';
    if (!preserveWorkflowStatus) state.status = 'failed';
    onStateChange(state);
    throw new InstallerError(
      'CONNECTION_CHECK_SUMMARY_INVALID',
      'The account-check execution returned inconsistent service results.',
      { safeDetails: { workflowUrl: check.openUrl } },
    );
  }
  const postExecutionDetails = await client.callTool('get_workflow_details', {
    workflowId: check.workflowId,
  });
  const postExecutionVerification = await verifyWorkflow({
    details: postExecutionDetails,
    workflowId: check.workflowId,
    workflowName: check.identity.name,
    workspaceOrigin: workspace.origin,
    apifyCredentialId: check.apifyCredentialId,
    googleCredentialId: check.googleCredentialId,
    apifyCredentialName: check.apifyCredentialName,
    googleCredentialName: check.googleCredentialName,
  });
  if (
    postExecutionVerification.workflowVersionId
      !== check.workflowVersionId
    ||
    postExecutionVerification.workflowVersionFingerprint
    !== check.workflowVersionFingerprint
  ) {
    check.status = 'failed';
    check.phase = 'workflow-version-changed';
    if (!preserveWorkflowStatus) state.status = 'failed';
    onStateChange(state);
    throw new InstallerError(
      'CONNECTION_CHECK_VERSION_CHANGED',
      'The account-check workflow changed during execution. Its result was not accepted.',
      { safeDetails: { workflowUrl: check.openUrl } },
    );
  }
  const checkedAt = new Date(now).toISOString();
  const evidence = connectionEvidence({
    workspaceOrigin: workspace.origin,
    workflowId: check.workflowId,
    workflowVersionId: check.workflowVersionId,
    workflowVersionFingerprint: check.workflowVersionFingerprint,
    executionId: check.executionId,
    apifyCredentialId: check.apifyCredentialId,
    googleCredentialId: check.googleCredentialId,
    apifyStatus,
    googleStatus,
    checkedAt,
    credentialReferenceReadback:
      postExecutionVerification.credentialReferenceReadback,
  });
  check.apifyStatus = apifyStatus;
  check.googleStatus = googleStatus;
  check.checkedAt = checkedAt;
  check.status = bothConnected ? 'checked' : 'failed';
  check.evidence = check.status === 'checked' ? evidence : null;
  check.phase = 'complete';
  if (!preserveWorkflowStatus) state.status = check.status;
  if (check.status !== 'checked') {
    invalidateCompletedTest(state, 'connection-check-failed');
  }
  onStateChange(state);
  if (check.status !== 'checked') {
    const error = new InstallerError(
      'CONNECTION_CHECK_FAILED',
      'One or more account checks did not pass. Review the service result, then use the suggested next step.',
    );
    error.safeDetails = {
      apifyStatus,
      googleStatus,
      ...(REAUTH_STATUSES.has(apifyStatus)
        ? {
          apifyCredentialUrl: `${workspace.origin}/home/credentials/${encodeURIComponent(check.apifyCredentialId)}`,
        }
        : {}),
      ...(REAUTH_STATUSES.has(googleStatus)
        ? {
          googleCredentialUrl: `${workspace.origin}/home/credentials/${encodeURIComponent(check.googleCredentialId)}`,
        }
        : {}),
      workflowUrl: check.openUrl,
    };
    throw error;
  }
  return evidence;
}

function invalidateCompletedTest(state, failureCategory) {
  const test = state?.testRun;
  if (!test || (test.testPassed !== true && test.outcome !== 'passed')) {
    return;
  }
  test.outcome = 'needs-attention';
  test.failureCategory = failureCategory;
  test.testPassed = false;
  test.inactiveAtCheck = false;
  test.lastCheckedAt = new Date().toISOString();
  if (state.status === 'tested') {
    state.status = 'installed-pending-test';
  }
}

export function invalidateConnectionCheck(state, reason = 'connection-changed') {
  if (!state?.connectionCheck) return;
  const check = state.connectionCheck;
  const unresolvedExecution = (
    check.executionRequested === true
    && (
      Boolean(check.executionId)
      || check.status === 'checking'
      || check.status === 'unknown'
    )
  );
  const unresolvedCreation = (
    check.createAttempted === true
    && ['checking', 'unknown'].includes(check.status)
  );
  check.evidence = null;
  if (!unresolvedExecution && !unresolvedCreation) {
    check.status = 'not-checked';
  }
  check.invalidationReason = reason;
  invalidateCompletedTest(state, 'connection-check-invalidated');
  if (
    !state.createAttempted
    && (state.status === 'checked' || state.status === 'installed-pending-test')
  ) {
    state.status = 'not-checked';
  }
}
