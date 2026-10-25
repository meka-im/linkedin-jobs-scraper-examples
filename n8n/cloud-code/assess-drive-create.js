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

const settings = $('Assess Drive Search').first()?.json ?? {};
const workflowId = String(settings.workflowId ?? '').trim();
if (!workflowId) {
  throw new Error('Assess Drive Search did not preserve the workflow ID');
}

const body = responseBody('Google Drive spreadsheet creation');
const spreadsheetId = String(body.id ?? '').trim();
if (!spreadsheetId) {
  throw new Error('Google Drive spreadsheet creation did not return an ID');
}
if (body.mimeType !== 'application/vnd.google-apps.spreadsheet') {
  throw new Error('Google Drive did not create a Google spreadsheet');
}

const properties = body.appProperties;
if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
  throw new Error('The created Google spreadsheet has no app properties');
}
if (properties.mekaLinkedinJobsWorkflow !== workflowId) {
  throw new Error('The created Google spreadsheet workflow tag is incorrect');
}
if (properties.mekaLinkedinJobsBootstrapState !== 'pending') {
  throw new Error('The created Google spreadsheet is not in pending bootstrap state');
}
if (
  properties.mekaLinkedinJobsSchemaVersion
  && properties.mekaLinkedinJobsSchemaVersion !== settings.schemaVersion
) {
  throw new Error('The created Google spreadsheet has an unsupported schema version');
}

return [{
  json: {
    ...settings,
    fileId: spreadsheetId,
    spreadsheetId,
    bootstrapState: 'pending',
    created: true,
    nextAction: 'inspect-sheet',
  },
}];
