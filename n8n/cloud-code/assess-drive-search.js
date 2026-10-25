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

const settings = $('Validate Cloud Settings').first()?.json ?? {};
const workflowId = String(settings.workflowId ?? '').trim();
if (!workflowId) {
  throw new Error('Validate Cloud Settings did not produce a workflow ID');
}

const body = responseBody('Google Drive spreadsheet lookup');
if (!Array.isArray(body.files)) {
  throw new Error('Google Drive spreadsheet lookup did not return a files array');
}
if (body.nextPageToken != null && String(body.nextPageToken).trim()) {
  throw new Error('Google Drive spreadsheet lookup returned another page; refusing an ambiguous match');
}
if (body.files.length > 1) {
  throw new Error('Multiple app spreadsheets are tagged for this workflow; refusing to choose one');
}
if (body.files.length === 0) {
  return [{ json: { ...settings, nextAction: 'create' } }];
}

const file = body.files[0];
if (!file || typeof file !== 'object' || Array.isArray(file)) {
  throw new Error('Google Drive spreadsheet lookup returned an invalid file');
}
if (file.mimeType !== 'application/vnd.google-apps.spreadsheet') {
  throw new Error('The tagged Google Drive file is not a Google spreadsheet');
}

const spreadsheetId = String(file.id ?? '').trim();
if (!spreadsheetId) {
  throw new Error('The tagged Google Drive file has no spreadsheet ID');
}

const properties = file.appProperties;
if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
  throw new Error('The tagged Google Drive file has no app properties');
}
if (properties.mekaLinkedinJobsWorkflow !== workflowId) {
  throw new Error('The Google Drive file workflow tag does not match this workflow');
}

const bootstrapState = String(properties.mekaLinkedinJobsBootstrapState ?? '').trim();
if (bootstrapState !== 'pending' && bootstrapState !== 'ready') {
  throw new Error('The tagged Google Drive file has an unsupported bootstrap state');
}

const schemaVersion = String(properties.mekaLinkedinJobsSchemaVersion ?? '').trim();
if (schemaVersion && schemaVersion !== settings.schemaVersion) {
  throw new Error(`Unsupported app spreadsheet schema version ${schemaVersion}`);
}

return [{
  json: {
    ...settings,
    fileId: spreadsheetId,
    spreadsheetId,
    bootstrapState,
    created: false,
    nextAction: 'reuse',
  },
}];
