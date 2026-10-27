import { InstallerError } from './errors.js';
import { parseWorkspaceUrl } from './workspace.js';

export const RELAY_ALLOWED_TOOLS = Object.freeze([
  'list_credentials',
  'validate_workflow',
  'create_workflow_from_code',
  'get_workflow_details',
  'search_workflows',
  'execute_workflow',
  'get_workflow_execution',
]);

export const RELAY_ALLOWED_NODE_SETS = Object.freeze({
  connectionCheck: Object.freeze([
    'Manual Trigger',
    'Check Apify OAuth',
    'Assess Apify Connection',
    'Check Google OAuth',
    'Assess Google Connection',
    'Connection Check Summary',
  ]),
  apifyConnectionCheck: Object.freeze([
    'Manual Trigger',
    'Check Apify OAuth',
    'Assess Apify Connection',
    'Connection Check Summary',
  ]),
  googleConnectionCheck: Object.freeze([
    'Manual Trigger',
    'Check Google OAuth',
    'Assess Google Connection',
    'Connection Check Summary',
  ]),
  mainWorkflow: Object.freeze([
    'Manual Trigger',
    'Daily Schedule',
    'Before Running',
    'Search settings',
    'Validate Cloud Settings',
    'Find App Spreadsheet',
    'Assess Drive Search',
    'Existing App Spreadsheet?',
    'Get Spreadsheet Metadata',
    'Create App Spreadsheet',
    'Assess Created Spreadsheet',
    'Assess Sheet Structure',
    'Has Jobs Worksheet?',
    'Add Jobs Worksheet',
    'Assess Added Sheet',
    'Get Jobs Header',
    'Assess Jobs Header',
    'Empty Header Found?',
    'Confirm Jobs Worksheet Empty',
    'Assess Empty Worksheet',
    'Write Jobs Header',
    'Assess Header Write',
    'Mark Spreadsheet Ready',
    'Assess Setup Ready',
    'Input Validation',
    'Start Actor',
    'Assess Start Run',
    'Is Run Succeeded?',
    'Wait for Actor',
    'Poll Actor Run',
    'Assess Polled Run',
    'Get Run Output',
    'Assess Run Output',
    'Get Dataset Items',
    'Normalize Jobs',
    'Read Existing Jobs',
    'Filter New IDs',
    'Has New Jobs?',
    'Split Out New Jobs',
    'Append Rows',
    'Read Written Jobs',
    'Run Summary',
  ]),
});

export const RELAY_ALLOWED_METHODS = Object.freeze([
  'server/discover',
  'initialize',
  'notifications/initialized',
  'tools/list',
  'tools/call',
]);

const ALLOWED_TOOL_SET = new Set(RELAY_ALLOWED_TOOLS);
const ALLOWED_METHOD_SET = new Set(RELAY_ALLOWED_METHODS);
const ALLOWED_NODE_SETS = Object.values(RELAY_ALLOWED_NODE_SETS).map(
  (names) => [...names].sort(),
);
const PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/u;

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) ?? '';
  const match = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match?.[1] ?? '';
}

export function validateRelayTarget(origin) {
  return parseWorkspaceUrl(origin);
}

function plainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function exactKeys(value, keys, toolName) {
  if (!plainObject(value)) {
    throw new InstallerError(
      'RELAY_ARGUMENTS_INVALID',
      `The ${toolName} arguments are invalid.`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new InstallerError(
      'RELAY_ARGUMENTS_REFUSED',
      `The ${toolName} arguments contain unapproved fields.`,
    );
  }
}

function boundedText(value, maximum, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new InstallerError(
      'RELAY_ARGUMENTS_INVALID',
      `${label} is invalid.`,
    );
  }
  return value;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new InstallerError(
      'RELAY_ARGUMENTS_INVALID',
      `${label} is invalid.`,
    );
  }
  return value;
}

function reviewableWorkflowCode(value) {
  const code = boundedText(value, 300_000, 'workflow code');
  if (
    !code.includes('LinkedIn jobs to Google Sheets (Cloud auto-setup)')
    && !code.includes('MEKA account check · ')
    && !code.includes('MEKA Apify account check · ')
    && !code.includes('MEKA Google account check · ')
  ) {
    throw new InstallerError(
      'RELAY_ARGUMENTS_REFUSED',
      'The relay only accepts the reviewed MEKA workflow builders.',
    );
  }
  return code;
}

function reviewedNodeSet(value) {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    return false;
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) return false;
  return ALLOWED_NODE_SETS.some((allowed) => (
    allowed.length === sorted.length
    && allowed.every((name, index) => name === sorted[index])
  ));
}

export function validateMcpToolArguments(toolName, args) {
  switch (toolName) {
    case 'list_credentials':
      exactKeys(args, ['type', 'limit'], toolName);
      if (
        !['apifyOAuth2Api', 'googleSheetsOAuth2Api'].includes(args.type)
        || args.limit !== 200
      ) {
        throw new InstallerError(
          'RELAY_ARGUMENTS_REFUSED',
          'The credential list request is outside the installer policy.',
        );
      }
      return;
    case 'validate_workflow':
      exactKeys(args, ['code'], toolName);
      reviewableWorkflowCode(args.code);
      return;
    case 'create_workflow_from_code':
      exactKeys(
        args,
        ['code', 'name', 'description', 'versionName', 'versionDescription'],
        toolName,
      );
      reviewableWorkflowCode(args.code);
      if (!/^MEKA(?:\s|$)/u.test(boundedText(args.name, 128, 'workflow name'))) {
        throw new InstallerError(
          'RELAY_ARGUMENTS_REFUSED',
          'The workflow name is outside the installer policy.',
        );
      }
      boundedText(args.description, 512, 'workflow description');
      boundedText(args.versionName, 128, 'version name');
      boundedText(args.versionDescription, 512, 'version description');
      return;
    case 'get_workflow_details':
      exactKeys(args, ['workflowId'], toolName);
      safeId(args.workflowId, 'workflow ID');
      return;
    case 'search_workflows':
      exactKeys(args, ['query', 'limit'], toolName);
      if (
        !/^MEKA(?:\s|$)/u.test(boundedText(args.query, 128, 'workflow query'))
        || args.limit !== 20
      ) {
        throw new InstallerError(
          'RELAY_ARGUMENTS_REFUSED',
          'The workflow search is outside the installer policy.',
        );
      }
      return;
    case 'execute_workflow':
      exactKeys(
        args,
        ['workflowId', 'executionMode', 'triggerNodeName'],
        toolName,
      );
      safeId(args.workflowId, 'workflow ID');
      if (
        args.executionMode !== 'manual'
        || args.triggerNodeName !== 'Manual Trigger'
      ) {
        throw new InstallerError(
          'RELAY_ARGUMENTS_REFUSED',
          'Only the explicit Manual Trigger execution is allowed.',
        );
      }
      return;
    case 'get_workflow_execution':
      if (!plainObject(args) || typeof args.includeData !== 'boolean') {
        throw new InstallerError(
          'RELAY_ARGUMENTS_INVALID',
          'The execution read request is invalid.',
        );
      }
      safeId(args.workflowId, 'workflow ID');
      safeId(args.executionId, 'execution ID');
      if (args.includeData === false) {
        exactKeys(args, ['workflowId', 'executionId', 'includeData'], toolName);
        return;
      }
      exactKeys(
        args,
        ['workflowId', 'executionId', 'includeData', 'nodeNames', 'truncateData'],
        toolName,
      );
      if (
        !reviewedNodeSet(args.nodeNames)
        || !args.nodeNames.includes('Run Summary')
          && !args.nodeNames.includes('Connection Check Summary')
        || args.truncateData !== 1
      ) {
        throw new InstallerError(
          'RELAY_ARGUMENTS_REFUSED',
          'Detailed execution data may only be requested for the complete reviewed node set.',
        );
      }
      return;
    default:
      throw new InstallerError(
        'RELAY_TOOL_REFUSED',
        'This MCP tool is not allowed by the installer relay.',
      );
  }
}

export function validateMcpRpcBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0') {
    throw new InstallerError('RELAY_REQUEST_INVALID', 'The relay only accepts one JSON-RPC request.');
  }
  if (typeof body.method !== 'string' || !ALLOWED_METHOD_SET.has(body.method)) {
    throw new InstallerError('RELAY_METHOD_REFUSED', 'This MCP method is not allowed by the installer relay.');
  }
  if (body.method === 'tools/call') {
    const toolName = body.params?.name;
    if (typeof toolName !== 'string' || !ALLOWED_TOOL_SET.has(toolName)) {
      throw new InstallerError('RELAY_TOOL_REFUSED', 'This MCP tool is not allowed by the installer relay.');
    }
    validateMcpToolArguments(toolName, body.params?.arguments);
    return {
      method: body.method,
      toolName,
      toolArguments: body.params.arguments,
    };
  }
  return { method: body.method, toolName: null, toolArguments: null };
}

export function validateRelayRoutingHeaders(headers, rpc) {
  const protocolVersion = headerValue(headers, 'mcp-protocol-version');
  const method = headerValue(headers, 'mcp-method');
  const toolName = headerValue(headers, 'mcp-name');
  if (protocolVersion && !PROTOCOL_VERSION.test(protocolVersion)) {
    throw new InstallerError('RELAY_HEADER_INVALID', 'The MCP protocol version header is invalid.');
  }
  if (method && method !== rpc.method) {
    throw new InstallerError('RELAY_HEADER_MISMATCH', 'The MCP method header does not match the request body.');
  }
  if (rpc.method === 'tools/call') {
    if (toolName && toolName !== rpc.toolName) {
      throw new InstallerError('RELAY_HEADER_MISMATCH', 'The MCP tool header does not match the request body.');
    }
  } else if (toolName) {
    throw new InstallerError('RELAY_HEADER_MISMATCH', 'The MCP tool header is not valid for this request.');
  }
}
