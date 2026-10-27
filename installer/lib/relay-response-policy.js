export const EXECUTION_RESPONSE_POLICY_VERSION = 'execution-response-v1';

const EXECUTION_TOOLS = new Set([
  'execute_workflow',
  'get_workflow_execution',
]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const SAFE_WORD = /^[A-Za-z0-9_-]{1,80}$/u;
const METADATA_FIELDS = Object.freeze([
  'id',
  'workflowId',
  'mode',
  'status',
  'startedAt',
  'stoppedAt',
  'retryOf',
  'retrySuccessId',
  'waitTill',
]);
const SUMMARY_NUMBER_FIELDS = Object.freeze([
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
]);
const SUMMARY_BOOLEAN_FIELDS = Object.freeze([
  'testPassed',
  'budgetStopped',
  'readbackVerified',
  'previousRowsUnchanged',
  'allFieldsPresent',
  'firstSeenAtPresent',
  'uniqueIds',
  'manualRun',
  'companyEnrichmentDisabled',
]);
const SUMMARY_STRING_FIELDS = Object.freeze([
  'status',
  'failureCategory',
  'coverage',
  'apifyStatus',
  'googleStatus',
  'executionMode',
]);
const SUMMARY_ID_FIELDS = Object.freeze([
  'workflowId',
  'executionId',
]);

function plainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function safeRpcId(value) {
  return Number.isSafeInteger(value)
    || (typeof value === 'string' && value.length <= 200)
    ? value
    : null;
}

function safeRpcError(id, category = 'sanitized-response-unavailable') {
  return {
    jsonrpc: '2.0',
    id: safeRpcId(id),
    error: {
      code: -32000,
      message: category,
    },
  };
}

function safeToolError(category) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: JSON.stringify({ errorCategory: category }),
    }],
    structuredContent: { errorCategory: category },
  };
}

function safeMetadataValue(value) {
  return value == null
    || (typeof value === 'string' && value.length <= 200)
    || typeof value === 'boolean'
    || Number.isSafeInteger(value);
}

function safeExecution(execution) {
  if (!plainObject(execution)) {
    throw new Error('EXECUTION_METADATA_INVALID');
  }
  const output = {};
  for (const field of METADATA_FIELDS) {
    if (
      Object.hasOwn(execution, field)
      && safeMetadataValue(execution[field])
    ) {
      output[field] = execution[field];
    }
  }
  if (
    typeof output.id !== 'string'
    || !SAFE_ID.test(output.id)
    || typeof output.workflowId !== 'string'
    || !SAFE_ID.test(output.workflowId)
    || typeof output.status !== 'string'
    || !SAFE_WORD.test(output.status)
  ) {
    throw new Error('EXECUTION_METADATA_INVALID');
  }
  return output;
}

function safeSummary(summary) {
  if (!plainObject(summary)) {
    throw new Error('EXECUTION_SUMMARY_INVALID');
  }
  const output = {};
  for (const field of SUMMARY_STRING_FIELDS) {
    if (
      typeof summary[field] === 'string'
      && SAFE_WORD.test(summary[field])
    ) {
      output[field] = summary[field];
    }
  }
  for (const field of SUMMARY_ID_FIELDS) {
    if (
      typeof summary[field] === 'string'
      && SAFE_ID.test(summary[field])
    ) {
      output[field] = summary[field];
    }
  }
  for (const field of SUMMARY_NUMBER_FIELDS) {
    if (Number.isFinite(summary[field])) {
      output[field] = Number(summary[field]);
    }
  }
  for (const field of SUMMARY_BOOLEAN_FIELDS) {
    if (typeof summary[field] === 'boolean') {
      output[field] = summary[field];
    }
  }
  return output;
}

function pinnedServiceDataState(payload) {
  const resultData = payload?.data?.resultData;
  if (!plainObject(resultData) || !Object.hasOwn(resultData, 'pinData')) {
    return 'unknown';
  }
  if (!plainObject(resultData.pinData)) {
    return 'unknown';
  }
  return Object.keys(resultData.pinData).some(
    (nodeName) => nodeName !== 'Manual Trigger',
  );
}

function summaryNodeName(args) {
  const nodeNames = Array.isArray(args?.nodeNames) ? args.nodeNames : [];
  const summaries = nodeNames.filter(
    (name) => name === 'Run Summary' || name === 'Connection Check Summary',
  );
  if (summaries.length !== 1) {
    throw new Error('EXECUTION_SUMMARY_NODE_INVALID');
  }
  return summaries[0];
}

function executionValue(payload, args) {
  const execution = safeExecution(payload?.execution);
  if (
    execution.id !== args?.executionId
    || execution.workflowId !== args?.workflowId
  ) {
    throw new Error('EXECUTION_ID_MISMATCH');
  }
  if (args.includeData !== true) {
    return {
      execution,
      responsePolicy: EXECUTION_RESPONSE_POLICY_VERSION,
    };
  }

  const nodeName = summaryNodeName(args);
  const summary = payload?.data?.resultData?.runData?.[nodeName]?.[0]
    ?.data?.main?.[0]?.[0]?.json;
  if (!plainObject(summary)) {
    throw new Error('EXECUTION_SUMMARY_INVALID');
  }
  return {
    execution,
    summary: safeSummary(summary),
    hasPinnedServiceData: pinnedServiceDataState(payload),
    responsePolicy: EXECUTION_RESPONSE_POLICY_VERSION,
  };
}

function executeValue(payload) {
  if (!plainObject(payload)) {
    throw new Error('EXECUTE_RESPONSE_INVALID');
  }
  if (payload.status === 'error') {
    return {
      executionId: null,
      status: 'error',
      errorCategory: 'execute-rejected',
      responsePolicy: EXECUTION_RESPONSE_POLICY_VERSION,
    };
  }
  if (
    payload.status !== 'started'
    || typeof payload.executionId !== 'string'
    || !SAFE_ID.test(payload.executionId)
  ) {
    throw new Error('EXECUTE_RESPONSE_INVALID');
  }
  return {
    executionId: payload.executionId,
    status: 'started',
    responsePolicy: EXECUTION_RESPONSE_POLICY_VERSION,
  };
}

export function sanitizeExecutionToolValue(toolName, args, payload) {
  if (toolName === 'execute_workflow') return executeValue(payload);
  if (toolName === 'get_workflow_execution') {
    if (
      typeof args?.includeData !== 'boolean'
      || typeof args?.workflowId !== 'string'
      || !SAFE_ID.test(args.workflowId)
      || typeof args?.executionId !== 'string'
      || !SAFE_ID.test(args.executionId)
    ) {
      throw new Error('EXECUTION_REQUEST_INVALID');
    }
    return executionValue(payload, args);
  }
  throw new Error('EXECUTION_TOOL_INVALID');
}

export function validateSanitizedExecutionToolValue(toolName, args, payload) {
  if (
    !plainObject(payload)
    || payload.responsePolicy !== EXECUTION_RESPONSE_POLICY_VERSION
  ) {
    throw new Error('SANITIZED_RESPONSE_POLICY_MISSING');
  }
  if (toolName === 'execute_workflow') return executeValue(payload);
  if (toolName !== 'get_workflow_execution') {
    throw new Error('EXECUTION_TOOL_INVALID');
  }
  const execution = safeExecution(payload.execution);
  if (
    execution.id !== args?.executionId
    || execution.workflowId !== args?.workflowId
  ) {
    throw new Error('EXECUTION_ID_MISMATCH');
  }
  if (args?.includeData !== true) {
    return {
      execution,
      responsePolicy: EXECUTION_RESPONSE_POLICY_VERSION,
    };
  }
  if (!plainObject(payload.summary)) {
    throw new Error('EXECUTION_SUMMARY_INVALID');
  }
  if (
    payload.hasPinnedServiceData !== true
    && payload.hasPinnedServiceData !== false
    && payload.hasPinnedServiceData !== 'unknown'
  ) {
    throw new Error('EXECUTION_PIN_EVIDENCE_INVALID');
  }
  return {
    execution,
    summary: safeSummary(payload.summary),
    hasPinnedServiceData: payload.hasPinnedServiceData,
    responsePolicy: EXECUTION_RESPONSE_POLICY_VERSION,
  };
}

function parseToolValue(result) {
  if (!plainObject(result)) return null;
  if (Object.hasOwn(result, 'structuredContent')) {
    return plainObject(result.structuredContent)
      ? result.structuredContent
      : null;
  }
  const text = Array.isArray(result.content)
    ? result.content.find(
      (item) => item?.type === 'text' && typeof item.text === 'string',
    )?.text
    : null;
  if (!text || text.length > 5_000_000) return null;
  try {
    const parsed = JSON.parse(text);
    return plainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeResult(result, toolName, args) {
  if (!plainObject(result)) return safeToolError('sanitized-response-invalid');
  if (result.isError === true) return safeToolError('tool-rejected');
  const value = parseToolValue(result);
  if (!value) return safeToolError('sanitized-response-invalid');
  try {
    const sanitized = sanitizeExecutionToolValue(toolName, args, value);
    return {
      content: [{ type: 'text', text: JSON.stringify(sanitized) }],
      structuredContent: sanitized,
    };
  } catch {
    return safeToolError('sanitized-response-invalid');
  }
}

function sanitizeMessage(message, toolName, args) {
  if (!plainObject(message)) {
    return safeRpcError(null, 'sanitized-response-invalid');
  }
  const id = safeRpcId(message.id);
  if (Object.hasOwn(message, 'error')) {
    return safeRpcError(id, 'execution-tool-rejected');
  }
  if (!Object.hasOwn(message, 'result')) {
    return safeRpcError(id, 'sanitized-response-invalid');
  }
  return {
    jsonrpc: '2.0',
    id,
    result: safeResult(message.result, toolName, args),
  };
}

function sanitizeSse(text, toolName, args) {
  const output = [];
  for (const frame of text.split(/\r?\n\r?\n/u)) {
    if (!frame.trim()) continue;
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
      return `data: ${JSON.stringify(
        safeRpcError(null, 'sanitized-response-invalid'),
      )}\n\n`;
    }
    output.push(
      `data: ${JSON.stringify(sanitizeMessage(parsed, toolName, args))}`,
    );
  }
  if (output.length === 0) {
    return `data: ${JSON.stringify(
      safeRpcError(null, 'sanitized-response-invalid'),
    )}\n\n`;
  }
  return `${output.join('\n\n')}\n\n`;
}

function validatedResult(result, toolName, args) {
  if (!plainObject(result)) return safeToolError('sanitized-response-invalid');
  if (result.isError === true) return safeToolError('tool-rejected');
  const value = parseToolValue(result);
  if (!value) return safeToolError('sanitized-response-invalid');
  try {
    const validated = validateSanitizedExecutionToolValue(toolName, args, value);
    return {
      content: [{ type: 'text', text: JSON.stringify(validated) }],
      structuredContent: validated,
    };
  } catch {
    return safeToolError('sanitized-response-invalid');
  }
}

function validateSanitizedMessage(message, toolName, args) {
  if (!plainObject(message)) {
    return safeRpcError(null, 'sanitized-response-invalid');
  }
  const id = safeRpcId(message.id);
  if (Object.hasOwn(message, 'error')) {
    return safeRpcError(id, 'execution-tool-rejected');
  }
  if (!Object.hasOwn(message, 'result')) {
    return safeRpcError(id, 'sanitized-response-invalid');
  }
  return {
    jsonrpc: '2.0',
    id,
    result: validatedResult(message.result, toolName, args),
  };
}

function validateSanitizedSse(text, toolName, args) {
  const output = [];
  for (const frame of text.split(/\r?\n\r?\n/u)) {
    if (!frame.trim()) continue;
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
      return `data: ${JSON.stringify(
        safeRpcError(null, 'sanitized-response-invalid'),
      )}\n\n`;
    }
    output.push(
      `data: ${JSON.stringify(
        validateSanitizedMessage(parsed, toolName, args),
      )}`,
    );
  }
  if (output.length === 0) {
    return `data: ${JSON.stringify(
      safeRpcError(null, 'sanitized-response-invalid'),
    )}\n\n`;
  }
  return `${output.join('\n\n')}\n\n`;
}

export function sanitizeMcpResponseBody({
  toolName,
  arguments: args,
  contentType,
  body,
}) {
  if (!EXECUTION_TOOLS.has(toolName)) return body;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextEncoder().encode(
      JSON.stringify(safeRpcError(null, 'sanitized-response-invalid')),
    );
  }
  let sanitized;
  if (String(contentType).toLowerCase().includes('text/event-stream')) {
    sanitized = sanitizeSse(text, toolName, args);
  } else {
    try {
      const parsed = JSON.parse(text);
      sanitized = JSON.stringify(sanitizeMessage(parsed, toolName, args));
    } catch {
      sanitized = JSON.stringify(
        safeRpcError(null, 'sanitized-response-invalid'),
      );
    }
  }
  return new TextEncoder().encode(sanitized);
}

export function validateSanitizedMcpResponseBody({
  toolName,
  arguments: args,
  contentType,
  body,
}) {
  if (!EXECUTION_TOOLS.has(toolName)) {
    return new TextEncoder().encode(
      JSON.stringify(safeRpcError(null, 'sanitized-response-invalid')),
    );
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextEncoder().encode(
      JSON.stringify(safeRpcError(null, 'sanitized-response-invalid')),
    );
  }
  let validated;
  if (String(contentType).toLowerCase().includes('text/event-stream')) {
    validated = validateSanitizedSse(text, toolName, args);
  } else {
    try {
      const parsed = JSON.parse(text);
      validated = JSON.stringify(
        validateSanitizedMessage(parsed, toolName, args),
      );
    } catch {
      validated = JSON.stringify(
        safeRpcError(null, 'sanitized-response-invalid'),
      );
    }
  }
  return new TextEncoder().encode(validated);
}
