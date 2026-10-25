const response = $input.first()?.json ?? {};
const settings = $('Input Validation').first()?.json ?? {};

let body = response.body !== undefined ? response.body : response;
if (typeof body === 'string') {
  try {
    body = JSON.parse(body);
  } catch {
    throw new Error('Apify start response was not valid JSON');
  }
}

const run = body?.data ?? body;
if (!run || typeof run !== 'object') {
  throw new Error('Apify start response did not contain a run');
}

const runId = String(run.id ?? '').trim();
if (!runId) {
  throw new Error('Apify start response did not contain a run ID');
}

const status = String(run.status ?? '').trim().toUpperCase();
const datasetId = String(run.defaultDatasetId ?? '').trim();
const state = {
  ...settings,
  runId,
  datasetId,
  status,
  pollCount: 0,
};

if (status === 'SUCCEEDED') {
  if (!datasetId) {
    throw new Error(`Actor run ${runId} succeeded without a defaultDatasetId`);
  }
  return [{ json: { ...state, nextAction: 'fetch' } }];
}

if (status === 'READY' || status === 'RUNNING') {
  if (Date.now() >= settings.runDeadlineEpochMs) {
    throw new Error(`Actor run ${runId} is still ${status} after the local deadline. Recovery run ID: ${runId}`);
  }
  return [{ json: { ...state, nextAction: 'poll' } }];
}

throw new Error(`Actor run ${runId} ended with status ${status || 'UNKNOWN'}. Recovery run ID: ${runId}`);
