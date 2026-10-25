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
const body = responseBody('Google Sheets header lookup');

if (body.values != null && !Array.isArray(body.values)) {
  throw new Error('Google Sheets header lookup returned invalid values');
}
const rows = body.values ?? [];
for (const row of rows) {
  if (!Array.isArray(row)) {
    throw new Error('Google Sheets header lookup returned a non-row value');
  }
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

const header = (rows[0] ?? []).map(text);
const hasHeader = (
  header.length === expectedHeader.length
  && header.every((value, index) => value === expectedHeader[index])
);
if (hasHeader) {
  return [{ json: { ...state, nextAction: 'continue' } }];
}

if (state.bootstrapState === 'ready') {
  throw new Error(
    'The ready app spreadsheet has a missing or incompatible Jobs header; refusing to reset it automatically',
  );
}

const headerHasContent = header.some((value) => value !== '');
if (headerHasContent) {
  throw new Error(
    'The existing Jobs worksheet has content, but row 1 is not the exact 10-column MEKA header; refusing to overwrite it',
  );
}

return [{ json: { ...state, nextAction: 'inspect-empty' } }];
