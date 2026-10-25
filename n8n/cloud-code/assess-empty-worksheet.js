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

const state = $('Assess Jobs Header').first()?.json ?? {};
if (state.bootstrapState !== 'pending') {
  throw new Error('Empty-worksheet confirmation is allowed only while bootstrap is pending');
}
if (typeof state.emptyCheckRange !== 'string' || !state.emptyCheckRange.trim()) {
  throw new Error('Bootstrap state did not include a bounded worksheet range');
}

const body = responseBody('Google Sheets empty-worksheet confirmation');
if (body.values != null && !Array.isArray(body.values)) {
  throw new Error('Google Sheets empty-worksheet confirmation returned invalid values');
}
for (const row of body.values ?? []) {
  if (!Array.isArray(row)) {
    throw new Error('Google Sheets empty-worksheet confirmation returned a non-row value');
  }
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

const hasContent = (body.values ?? []).some(
  (row) => row.some((value) => text(value) !== ''),
);
if (hasContent) {
  throw new Error(
    'The Jobs worksheet has content outside the empty header row; refusing to overwrite it',
  );
}

return [{
  json: {
    ...state,
    nextAction: 'write-header',
  },
}];
