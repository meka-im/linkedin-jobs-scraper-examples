function previousIfExecuted(name) {
  try {
    return $(name).first()?.json ?? null;
  } catch {
    return null;
  }
}

function responseBody(label) {
  const response = $input.first()?.json ?? {};
  const statusCode = Number(response.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
    throw new Error(`${label} failed with HTTP ${Number.isFinite(statusCode) ? statusCode : 'NO_STATUS'}`);
  }

  let body = response.body !== undefined ? response.body : response;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      throw new Error(`${label} returned invalid JSON`);
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`${label} returned an invalid response`);
  }
  return body;
}

const structure = $('Assess Sheet Structure').first()?.json ?? {};
const added = previousIfExecuted('Assess Added Sheet');
const state = { ...structure, ...(added ?? {}) };
const body = responseBody('Google Drive ready-state update');
const spreadsheetId = String(state.spreadsheetId ?? '').trim();
const workflowId = String(state.workflowId ?? '').trim();
if (!spreadsheetId || !workflowId) {
  throw new Error('Bootstrap setup state is incomplete');
}
if (String(body.id ?? '').trim() !== spreadsheetId) {
  throw new Error('Google Drive ready-state update changed or omitted the spreadsheet ID');
}

const properties = body.appProperties;
if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
  throw new Error('Google Drive ready-state update did not return app properties');
}
if (properties.mekaLinkedinJobsWorkflow !== workflowId) {
  throw new Error('Google Drive ready-state update changed the workflow tag');
}
if (properties.mekaLinkedinJobsBootstrapState !== 'ready') {
  throw new Error('Google Drive ready-state update did not persist ready state');
}
if (properties.mekaLinkedinJobsSchemaVersion !== '1') {
  throw new Error('Google Drive ready-state update did not preserve schema version 1');
}

return [{
  json: {
    ...state,
    sheetId: spreadsheetId,
    sheetName: 'Jobs',
    spreadsheetTitle: state.spreadsheetTitle,
    workflowId,
    bootstrapState: 'ready',
  },
}];
