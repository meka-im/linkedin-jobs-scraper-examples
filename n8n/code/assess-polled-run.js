const previous = $('Wait for Actor').first()?.json ?? {};
const response = $input.first()?.json ?? {};
const settings = $('Input Validation').first()?.json ?? {};

let body = response.body !== undefined ? response.body : response;
if (typeof body === 'string') {
  try {
    body = JSON.parse(body);
  } catch {
    throw new Error(`Apify poll response for run ${previous.runId ?? 'UNKNOWN'} was not valid JSON`);
  }
}

const run = body?.data ?? body;
if (!run || typeof run !== 'object') {
  throw new Error(`Apify poll response did not contain run ${previous.runId ?? 'UNKNOWN'}`);
}

const runId = String(run.id ?? previous.runId ?? '').trim();
if (!runId || runId !== previous.runId) {
  throw new Error(`Apify poll response changed or omitted run ID ${previous.runId ?? 'UNKNOWN'}`);
}

const status = String(run.status ?? '').trim().toUpperCase();
const datasetId = String(run.defaultDatasetId ?? previous.datasetId ?? '').trim();
const pollCount = Number(previous.pollCount ?? 0) + 1;
const state = {
  ...previous,
  status,
  datasetId,
  pollCount,
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
  if (pollCount >= settings.maxPollAttempts) {
    throw new Error(`Actor run ${runId} did not finish after ${pollCount} polls. Recovery run ID: ${runId}`);
  }
  return [{ json: { ...state, nextAction: 'poll' } }];
}

throw new Error(`Actor run ${runId} ended with status ${status || 'UNKNOWN'}. Recovery run ID: ${runId}`);
