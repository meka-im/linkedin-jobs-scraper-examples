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

const expectedHeader = [
  'id',
  'title',
  'company',
  'location',
  'postedAt',
  'url',
  'salary',
  'employmentType',
  'seniority',
  'firstSeenAt',
];

const structure = $('Assess Sheet Structure').first()?.json ?? {};
const added = previousIfExecuted('Assess Added Sheet');
const state = { ...structure, ...(added ?? {}) };
const body = responseBody('Google Sheets header write');

if (String(body.spreadsheetId ?? '').trim() !== String(state.spreadsheetId ?? '').trim()) {
  throw new Error('Google Sheets header write returned a different spreadsheet ID');
}

function normalizeSheetRange(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replaceAll('$', '');
}
const updatedRange = normalizeSheetRange(body.updatedRange);
const updatedDataRange = normalizeSheetRange(body.updatedData?.range);
if (
  !['JOBS!A1:J1', "'JOBS'!A1:J1"].includes(updatedRange)
  || !['JOBS!A1:J1', "'JOBS'!A1:J1"].includes(updatedDataRange)
) {
  throw new Error('Google Sheets header write returned an unexpected updated range');
}
if (body.updatedRows !== 1 || body.updatedColumns !== 10 || body.updatedCells !== 10) {
  throw new Error('Google Sheets header write returned unexpected update counts');
}
if (!Array.isArray(body.updatedData?.values) || body.updatedData.values.length !== 1) {
  throw new Error('Google Sheets header write did not echo the written row');
}
const header = body.updatedData.values[0];
if (
  !Array.isArray(header)
  || header.length !== expectedHeader.length
  || header.some((value, index) => String(value ?? '').trim() !== expectedHeader[index])
) {
  throw new Error('Google Sheets header write did not preserve the exact 10-column header');
}

return [{
  json: {
    ...state,
    nextAction: 'mark-ready',
  },
}];
