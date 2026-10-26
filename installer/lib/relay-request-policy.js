import { InstallerError } from './errors.js';
import { parseWorkspaceUrl } from './workspace.js';

export const RELAY_ALLOWED_TOOLS = Object.freeze([
  'list_credentials',
  'validate_workflow',
  'create_workflow_from_code',
  'get_workflow_details',
  'search_workflows',
]);

export const RELAY_ALLOWED_METHODS = Object.freeze([
  'server/discover',
  'initialize',
  'notifications/initialized',
  'tools/list',
  'tools/call',
]);

const ALLOWED_TOOL_SET = new Set(RELAY_ALLOWED_TOOLS);
const ALLOWED_METHOD_SET = new Set(RELAY_ALLOWED_METHODS);
const PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/u;

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
    return { method: body.method, toolName };
  }
  return { method: body.method, toolName: null };
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
