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

const settings = $('Validate Cloud Settings').first()?.json ?? {};
const search = $('Assess Drive Search').first()?.json ?? {};
const created = previousIfExecuted('Assess Created Spreadsheet');
const spreadsheetId = String(
  created?.spreadsheetId ?? search.spreadsheetId ?? '',
).trim();
const bootstrapState = String(
  created?.bootstrapState ?? search.bootstrapState ?? '',
).trim();
if (!spreadsheetId) {
  throw new Error('Bootstrap did not resolve a spreadsheet ID');
}
if (bootstrapState !== 'pending' && bootstrapState !== 'ready') {
  throw new Error('Bootstrap did not resolve a supported spreadsheet state');
}

const body = responseBody('Google Sheets metadata lookup');
if (!Array.isArray(body.sheets)) {
  throw new Error('Google Sheets metadata lookup did not return a sheets array');
}

const jobsSheets = body.sheets.filter(
  (sheet) => sheet?.properties?.title === 'Jobs',
);
if (jobsSheets.length > 1) {
  throw new Error('The spreadsheet contains multiple Jobs worksheets; refusing an ambiguous match');
}

const base = { ...settings, ...search, ...(created ?? {}), spreadsheetId };
if (jobsSheets.length === 0) {
  if (bootstrapState === 'ready') {
    throw new Error('The ready app spreadsheet is missing its Jobs worksheet');
  }
  return [{ json: { ...base, bootstrapState, nextAction: 'add-sheet' } }];
}

const sheetId = jobsSheets[0].properties?.sheetId;
if (!Number.isInteger(sheetId)) {
  throw new Error('The Jobs worksheet has an invalid sheet ID');
}

const gridProperties = jobsSheets[0].properties?.gridProperties;
const rowCount = gridProperties?.rowCount;
const columnCount = gridProperties?.columnCount;
if (
  !Number.isInteger(rowCount)
  || rowCount < 1
  || !Number.isInteger(columnCount)
  || columnCount < 1
) {
  throw new Error('The Jobs worksheet has invalid grid bounds');
}

function columnLabel(value) {
  let remaining = value;
  let label = '';
  while (remaining > 0) {
    remaining -= 1;
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26);
  }
  return label;
}

return [{
  json: {
    ...base,
    bootstrapState,
    sheetId,
    sheetName: 'Jobs',
    emptyCheckRange: `Jobs!A1:${columnLabel(columnCount)}${rowCount}`,
    nextAction: 'check-header',
  },
}];
