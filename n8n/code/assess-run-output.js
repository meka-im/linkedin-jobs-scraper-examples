const response = $input.first()?.json ?? {};
const state = $('Is Run Succeeded?').first()?.json ?? {};

let body = response.body !== undefined ? response.body : response;
if (typeof body === 'string') {
  try {
    body = JSON.parse(body);
  } catch {
    throw new Error(`Actor run ${state.runId ?? 'UNKNOWN'} returned an invalid OUTPUT summary`);
  }
}
const summary = body?.data ?? body;
if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
  throw new Error(`Actor run ${state.runId ?? 'UNKNOWN'} returned an invalid OUTPUT summary`);
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
const clean = { status: String(summary.status ?? '') };
for (const field of numericFields) {
  const value = summary[field];
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Actor run ${state.runId ?? 'UNKNOWN'} OUTPUT summary has an invalid ${field}`);
  }
  clean[field] = value;
}
if (typeof summary.stoppedByBudget !== 'boolean') {
  throw new Error(`Actor run ${state.runId ?? 'UNKNOWN'} OUTPUT summary has an invalid stoppedByBudget`);
}
clean.stoppedByBudget = summary.stoppedByBudget;

if (clean.failedSearches > 0) {
  throw new Error(
    `Actor run ${state.runId ?? 'UNKNOWN'} completed with ${clean.failedSearches} failed search(es); no dataset was accepted. Recovery run ID: ${state.runId ?? 'UNKNOWN'}`,
  );
}

clean.coverage = (
  clean.failedJobDetails > 0
  || clean.failedCompanies > 0
  || clean.stoppedByBudget
) ? 'partial' : 'complete';

return [{
  json: {
    ...state,
    actorSummary: clean,
    coverage: clean.coverage,
  },
}];
