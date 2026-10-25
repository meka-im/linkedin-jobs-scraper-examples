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

const state = $('Assess Sheet Structure').first()?.json ?? {};
const body = responseBody('Google Sheets worksheet creation');
if (!Array.isArray(body.replies)) {
  throw new Error('Google Sheets worksheet creation did not return replies');
}

const jobsSheetId = 1731133718;
const properties = body.replies
  .map((reply) => reply?.addSheet?.properties)
  .find(Boolean);
if (!properties || properties.title !== 'Jobs' || properties.sheetId !== jobsSheetId) {
  throw new Error('Google Sheets did not create the expected Jobs worksheet');
}
const rowCount = properties.gridProperties?.rowCount;
const columnCount = properties.gridProperties?.columnCount;
if (
  !Number.isInteger(rowCount)
  || rowCount < 1
  || !Number.isInteger(columnCount)
  || columnCount < 1
) {
  throw new Error('Google Sheets created the Jobs worksheet with invalid grid bounds');
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
    ...state,
    sheetId: jobsSheetId,
    sheetName: 'Jobs',
    emptyCheckRange: `Jobs!A1:${columnLabel(columnCount)}${rowCount}`,
    nextAction: 'check-header',
  },
}];
