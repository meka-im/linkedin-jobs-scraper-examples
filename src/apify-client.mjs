const DEFAULT_API_BASE_URL = 'https://api.apify.com';
const ACTOR_ID = 'meka.im~linkedin-jobs-scraper';
const PENDING_STATUSES = new Set(['READY', 'RUNNING']);

export class ActorRunError extends Error {
  constructor(message, { runId = null, status = null } = {}) {
    super(message);
    this.name = 'ActorRunError';
    this.runId = runId;
    this.status = status;
  }
}

function asRun(payload) {
  const run = payload?.data ?? payload;
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new ActorRunError('Apify response did not contain a run object');
  }
  return run;
}

function runIdOf(run) {
  const runId = String(run.id ?? '').trim();
  if (!runId) {
    throw new ActorRunError('Apify response did not contain a run ID');
  }
  return runId;
}

function statusOf(run) {
  return String(run.status ?? '').trim().toUpperCase();
}

function datasetIdOf(run) {
  return String(run.defaultDatasetId ?? '').trim();
}

function validateActorInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ActorRunError('Input must be a JSON object');
  }
  if (!Number.isInteger(input.count) || input.count < 1) {
    throw new ActorRunError('input.count must be a positive integer');
  }
  if (!Number.isInteger(input.limitPerSource) || input.limitPerSource < 1) {
    throw new ActorRunError('input.limitPerSource must be a positive integer');
  }
  const hasKeywords = typeof input.keywords === 'string' && input.keywords.trim();
  const hasUrls = Array.isArray(input.urls) && input.urls.length > 0;
  const hasCompanies = Array.isArray(input.companyIds) && input.companyIds.length > 0;
  if (!hasKeywords && !hasUrls && !hasCompanies) {
    throw new ActorRunError('Input must include keywords, urls, or companyIds');
  }
  if (input.datePosted !== undefined) {
    const allowed = new Set(['anyTime', 'past24Hours', 'pastWeek', 'pastMonth']);
    if (!allowed.has(input.datePosted)) {
      throw new ActorRunError('input.datePosted has an unsupported value');
    }
  }
  if (input.scrapeCompany !== undefined && typeof input.scrapeCompany !== 'boolean') {
    throw new ActorRunError('input.scrapeCompany must be a boolean');
  }
}

function assertPublicJobs(items) {
  if (!Array.isArray(items)) {
    throw new ActorRunError('Dataset items response must be a JSON array');
  }
  items.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ActorRunError(`Dataset item ${index} is not an object`);
    }
    const id = String(item.id ?? '').trim();
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const link = typeof item.link === 'string' ? item.link.trim() : '';
    if (!/^[0-9]+$/.test(id) || !title) {
      throw new ActorRunError(`Dataset item ${index} must include a numeric id and non-empty title`);
    }
    let url;
    try {
      url = new URL(link);
    } catch {
      throw new ActorRunError(`Dataset item ${index} has an invalid link`);
    }
    if (
      url.protocol !== 'https:'
      || !(url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'))
      || !url.pathname.startsWith('/jobs/view/')
    ) {
      throw new ActorRunError(`Dataset item ${index} link must be a public LinkedIn job URL`);
    }
  });
  return items;
}

async function requestJson({
  fetchImpl,
  url,
  token,
  method = 'GET',
  body,
  runId = null,
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(70_000),
    });
  } catch (error) {
    const suffix = runId ? ` for run ${runId}` : '';
    throw new ActorRunError(`Apify request failed${suffix}: ${error.message}`, { runId });
  }

  const text = await response.text();
  if (!response.ok) {
    const suffix = runId ? ` for run ${runId}` : '';
    throw new ActorRunError(
      `Apify request returned HTTP ${response.status}${suffix}`,
      { runId },
    );
  }
  if (!text.trim()) {
    throw new ActorRunError('Apify returned an empty response body', { runId });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ActorRunError('Apify returned invalid JSON', { runId });
  }
}

export async function runLinkedInJobs({
  token,
  input,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  fetchImpl = globalThis.fetch,
  sleepFn = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowFn = Date.now,
  pollDelayMs = 5_000,
  maxPollAttempts = 6,
  runDeadlineMs = 480_000,
} = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new ActorRunError('APIFY_TOKEN is required');
  }
  validateActorInput(input);
  if (typeof fetchImpl !== 'function') {
    throw new ActorRunError('The runtime does not provide fetch');
  }

  const base = apiBaseUrl.replace(/\/+$/, '');
  const startUrl = new URL(`${base}/v2/acts/${ACTOR_ID}/runs`);
  startUrl.search = new URLSearchParams({
    memory: '512',
    timeout: '300',
    maxTotalChargeUsd: '0.05',
    waitForFinish: '60',
  }).toString();

  // This POST is sent once. Retrying it could start and charge for another run.
  const startPayload = await requestJson({
    fetchImpl,
    url: startUrl,
    token,
    method: 'POST',
    body: input,
  });
  let run = asRun(startPayload);
  let runId = runIdOf(run);
  const deadline = nowFn() + runDeadlineMs;
  let pollCount = 0;

  while (PENDING_STATUSES.has(statusOf(run))) {
    if (pollCount >= maxPollAttempts) {
      throw new ActorRunError(
        `Actor run ${runId} did not finish after ${pollCount} polls. Recovery run ID: ${runId}`,
        { runId, status: statusOf(run) },
      );
    }
    if (nowFn() >= deadline) {
      throw new ActorRunError(
        `Actor run ${runId} is still ${statusOf(run)} after the local deadline. Recovery run ID: ${runId}`,
        { runId, status: statusOf(run) },
      );
    }

    await sleepFn(pollDelayMs);
    const pollUrl = new URL(`${base}/v2/actor-runs/${encodeURIComponent(runId)}`);
    pollUrl.search = new URLSearchParams({ waitForFinish: '60' }).toString();
    run = asRun(await requestJson({
      fetchImpl,
      url: pollUrl,
      token,
      runId,
    }));
    const polledRunId = runIdOf(run);
    if (polledRunId !== runId) {
      throw new ActorRunError(
        `Apify poll response changed run ID from ${runId} to ${polledRunId}`,
        { runId },
      );
    }
    pollCount += 1;
  }

  const status = statusOf(run);
  if (status !== 'SUCCEEDED') {
    throw new ActorRunError(
      `Actor run ${runId} ended with status ${status || 'UNKNOWN'}. Recovery run ID: ${runId}`,
      { runId, status },
    );
  }

  const datasetId = datasetIdOf(run);
  if (!datasetId) {
    throw new ActorRunError(`Actor run ${runId} succeeded without a defaultDatasetId`, {
      runId,
      status,
    });
  }

  const outputUrl = new URL(
    `${base}/v2/actor-runs/${encodeURIComponent(runId)}/key-value-store/records/OUTPUT`,
  );
  const outputPayload = await requestJson({
    fetchImpl,
    url: outputUrl,
    token,
    runId,
  });
  const summaryPayload = outputPayload?.data ?? outputPayload;
  if (!summaryPayload || typeof summaryPayload !== 'object' || Array.isArray(summaryPayload)) {
    throw new ActorRunError(`Actor run ${runId} returned an invalid OUTPUT summary`, {
      runId,
      status,
    });
  }
  const numericFields = [
    'delivered',
    'uniqueJobs',
    'searchPages',
    'failedSearches',
    'failedJobDetails',
    'failedCompanies',
    'cacheHits',
  ];
  const summary = {
    status: String(summaryPayload.status ?? ''),
    stoppedByBudget: summaryPayload.stoppedByBudget,
  };
  for (const field of numericFields) {
    const value = summaryPayload[field];
    if (!Number.isInteger(value) || value < 0) {
      throw new ActorRunError(
        `Actor run ${runId} OUTPUT summary has an invalid ${field}`,
        { runId, status },
      );
    }
    summary[field] = value;
  }
  if (typeof summary.stoppedByBudget !== 'boolean') {
    throw new ActorRunError(`Actor run ${runId} OUTPUT summary has an invalid stoppedByBudget`, {
      runId,
      status,
    });
  }
  if (summary.failedSearches > 0) {
    throw new ActorRunError(
      `Actor run ${runId} completed with ${summary.failedSearches} failed search(es); `
      + `no dataset was accepted. Recovery run ID: ${runId}`,
      { runId, status },
    );
  }
  summary.coverage = (
    summary.failedJobDetails > 0
    || summary.failedCompanies > 0
    || summary.stoppedByBudget
  ) ? 'partial' : 'complete';

  const limit = input.count;
  const datasetUrl = new URL(`${base}/v2/datasets/${encodeURIComponent(datasetId)}/items`);
  datasetUrl.search = new URLSearchParams({
    format: 'json',
    clean: 'true',
    limit: String(limit),
  }).toString();

  let itemsPayload = await requestJson({
    fetchImpl,
    url: datasetUrl,
    token,
    runId,
  });
  if (!Array.isArray(itemsPayload) && Array.isArray(itemsPayload?.data)) {
    itemsPayload = itemsPayload.data;
  }
  const jobs = assertPublicJobs(itemsPayload);

  return {
    runId,
    datasetId,
    status,
    requestedLimit: limit,
    summary,
    jobs,
  };
}
