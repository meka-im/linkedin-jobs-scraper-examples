import { InstallerError } from './errors.js';
import {
  EXECUTION_RESPONSE_POLICY_VERSION,
  sanitizeExecutionToolValue,
  validateSanitizedExecutionToolValue,
} from './relay-response-policy.js';

const CLIENT_INFO = Object.freeze({
  name: 'MEKA n8n Cloud installer',
  version: '1.0.0',
});

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) ?? '';
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found?.[1] ?? '';
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new InstallerError('MCP_RESPONSE_INVALID', `${label} returned invalid JSON.`);
  }
}

export function parseMcpResponse(response, requestId = null) {
  if (!response || typeof response !== 'object') {
    throw new InstallerError('MCP_RESPONSE_INVALID', 'The MCP server returned an invalid response.');
  }
  const status = Number(response.status);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    if (status === 401 || status === 403) {
      throw new InstallerError(
        'MCP_AUTHORIZATION_FAILED',
        'n8n did not authorize this MCP request. Reconnect and verify the selected scopes.',
      );
    }
    if (status === 0 || status === 405 || status >= 500) {
      throw new InstallerError(
        'MCP_UNAVAILABLE',
        `The n8n MCP server was unavailable${Number.isFinite(status) && status ? ` (HTTP ${status})` : ''}.`,
      );
    }
    const error = new InstallerError(
      'MCP_REQUEST_FAILED',
      `The n8n MCP server rejected the request with HTTP ${Number.isFinite(status) ? status : 'unknown'}.`,
    );
    error.httpStatus = Number.isFinite(status) ? status : null;
    throw error;
  }

  const text = typeof response.text === 'string' ? response.text : '';
  if (!text.trim()) return null;
  const contentType = headerValue(response.headers, 'content-type').toLowerCase();
  if (contentType.includes('text/event-stream')) {
    const frames = text.split(/\r?\n\r?\n/u);
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!data || data === '[DONE]') continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (requestId == null || parsed?.id === requestId) return parsed;
    }
    throw new InstallerError('MCP_RESPONSE_INVALID', 'The MCP event stream had no matching response.');
  }

  return parseJson(text, 'The MCP server');
}

function rpcResult(message, label) {
  if (!message || message.jsonrpc !== '2.0') {
    throw new InstallerError('MCP_RESPONSE_INVALID', `${label} returned an invalid JSON-RPC response.`);
  }
  if (message.error) {
    const code = Number(message.error.code);
    const error = new InstallerError(
      'MCP_RPC_ERROR',
      `${label} was rejected by n8n. Retry only if the request is safe; otherwise reconnect and review MCP access.`,
    );
    error.rpcCode = Number.isFinite(code) ? code : null;
    throw error;
  }
  if (!Object.hasOwn(message, 'result')) {
    throw new InstallerError('MCP_RESPONSE_INVALID', `${label} did not return a result.`);
  }
  return message.result;
}

function toolPayload(result, label) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new InstallerError('MCP_TOOL_RESPONSE_INVALID', `${label} returned an invalid tool result.`);
  }
  if (result.isError === true) {
    throw new InstallerError(
      'MCP_TOOL_ERROR',
      `${label} was rejected by n8n. The installer does not display upstream tool text; review MCP access and try again.`,
    );
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const textItem = Array.isArray(result.content)
    ? result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')
    : null;
  if (!textItem) {
    throw new InstallerError('MCP_TOOL_RESPONSE_INVALID', `${label} returned no structured data.`);
  }
  return parseJson(textItem.text, label);
}

export class McpClient {
  constructor(transport) {
    if (!transport?.post || typeof transport.post !== 'function') {
      throw new InstallerError('MCP_TRANSPORT_INVALID', 'The MCP transport is unavailable.');
    }
    this.transport = transport;
    this.nextId = 1;
    this.protocolVersion = null;
    this.tools = new Map();
  }

  async post(message, { protocolVersion, methodName, toolName } = {}) {
    const response = await this.transport.post(message, {
      protocolVersion,
      methodName,
      toolName,
    });
    return parseMcpResponse(response, message.id ?? null);
  }

  async request(method, params = {}, { headers = {} } = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    const response = await this.post(message, {
      protocolVersion: headers.protocolVersion ?? this.protocolVersion,
      methodName: method,
      toolName: headers.toolName,
    });
    return rpcResult(response, method);
  }

  async notify(method, params = {}) {
    const message = { jsonrpc: '2.0', method, params };
    const response = await this.transport.post(message, {
      protocolVersion: this.protocolVersion,
      methodName: method,
    });
    if (response.status === 202 || response.status === 204 || !response.text?.trim()) return;
    parseMcpResponse(response, null);
  }

  async connect() {
    const modern = await this.tryModernHandshake();
    if (!modern) await this.initializeLegacy();
  }

  async tryModernHandshake() {
    try {
      await this.request(
        'server/discover',
        {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
          },
        },
        {
          headers: {
            protocolVersion: '2026-07-28',
            methodName: 'server/discover',
          },
        },
      );
      this.protocolVersion = '2026-07-28';
      return true;
    } catch (error) {
      if (
        error instanceof InstallerError
        && error.code === 'MCP_RPC_ERROR'
        && (error.rpcCode === -32601 || error.rpcCode === -32600)
      ) {
        return false;
      }
      if (
        error instanceof InstallerError
        && error.code === 'MCP_REQUEST_FAILED'
        && (error.httpStatus === 400 || error.httpStatus === 404)
      ) {
        return false;
      }
      throw error;
    }
  }

  async initializeLegacy() {
    let lastError;
    for (const version of ['2025-06-18', '2025-03-26']) {
      this.protocolVersion = version;
      try {
        const initialized = await this.request(
          'initialize',
          {
            protocolVersion: version,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
          {
            headers: {
              protocolVersion: version,
              methodName: 'initialize',
            },
          },
        );
        if (
          typeof initialized?.protocolVersion === 'string'
          && initialized.protocolVersion.startsWith('2025-')
        ) {
          this.protocolVersion = initialized.protocolVersion;
        }
        await this.notify('notifications/initialized', {});
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async listTools() {
    this.tools.clear();
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const params = cursor ? { cursor } : {};
      const result = await this.request('tools/list', params);
      if (!result || !Array.isArray(result.tools)) {
        throw new InstallerError('MCP_RESPONSE_INVALID', 'MCP tools/list returned an invalid list.');
      }
      for (const tool of result.tools) {
        if (typeof tool?.name === 'string' && tool.name) this.tools.set(tool.name, tool);
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : null;
      if (!cursor) return [...this.tools.values()];
    }
    throw new InstallerError('MCP_TOOL_PAGINATION_INVALID', 'MCP tool discovery exceeded the safe page limit.');
  }

  hasTool(name) {
    return this.tools.has(name);
  }

  requireTools(names) {
    const missing = names.filter((name) => !this.tools.has(name));
    if (missing.length > 0) {
      throw new InstallerError(
        'MCP_TOOLS_UNAVAILABLE',
        `Reconnect to n8n with workflow:read, workflow:write, credential:read, workflow:execute, and execution:read. The required MCP tools are unavailable: ${missing.join(', ')}.`,
      );
    }
  }

  async callTool(name, args = {}) {
    const result = await this.request(
      'tools/call',
      { name, arguments: args },
      {
        headers: {
          methodName: 'tools/call',
          toolName: name,
        },
      },
    );
    const payload = toolPayload(result, name);
    if (name !== 'execute_workflow' && name !== 'get_workflow_execution') {
      return payload;
    }
    try {
      return this.transport.responsePolicy === EXECUTION_RESPONSE_POLICY_VERSION
        ? validateSanitizedExecutionToolValue(name, args, payload)
        : sanitizeExecutionToolValue(name, args, payload);
    } catch {
      throw new InstallerError(
        'MCP_EXECUTION_RESPONSE_INVALID',
        'n8n returned execution data that could not be accepted without exposing private run details.',
      );
    }
  }
}
