const config = $input.first()?.json ?? {};

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

const workflowId = typeof $workflow === 'object'
  ? String($workflow?.id ?? '').trim()
  : '';
if (!workflowId) {
  throw new Error('Save this workflow before running it so $workflow.id is available');
}

const datePostedValues = new Set(['anyTime', 'past24Hours', 'pastWeek', 'pastMonth']);
const datePosted = requiredText(config.datePosted, 'datePosted');
if (!datePostedValues.has(datePosted)) {
  throw new Error(`datePosted must be one of ${[...datePostedValues].join(', ')}`);
}

const budgetUsd = Number(config.budgetUsd);
if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
  throw new Error('budgetUsd must be a positive number');
}

if (typeof config.scrapeCompany !== 'boolean') {
  throw new Error('scrapeCompany must be a boolean');
}

if (
  config.spreadsheetTitle != null
  && typeof config.spreadsheetTitle !== 'string'
) {
  throw new Error('spreadsheetTitle must be a string');
}
const spreadsheetTitle = config.spreadsheetTitle?.trim() || 'LinkedIn jobs';
if (spreadsheetTitle.length > 200) {
  throw new Error('spreadsheetTitle must be 200 characters or fewer');
}

const workflowIdQuery = workflowId
  .replaceAll('\\', '\\\\')
  .replaceAll("'", "\\'");

const requestedLimit = positiveInteger(config.limit, 'limit', 1000);
const executionMode = typeof $execution === 'object'
  ? String($execution?.mode ?? '').trim()
  : '';
if (executionMode !== 'test' && executionMode !== 'production') {
  throw new Error('$execution.mode must be either test or production');
}
const manualRun = executionMode === 'test';
const effectiveLimit = manualRun
  ? Math.min(requestedLimit, 10)
  : requestedLimit;
const effectiveBudgetUsd = manualRun
  ? Math.min(budgetUsd, 0.05)
  : budgetUsd;
const effectiveScrapeCompany = manualRun ? false : config.scrapeCompany;

return [{
  json: {
    keywords: requiredText(config.keywords, 'keywords'),
    location: requiredText(config.location, 'location'),
    datePosted,
    limit: effectiveLimit,
    budgetUsd: effectiveBudgetUsd,
    scrapeCompany: effectiveScrapeCompany,
    spreadsheetTitle,
    workflowId,
    workflowIdQuery,
    sheetName: 'Jobs',
    schemaVersion: '1',
    executionMode,
    manualRun,
    requestedLimit,
    requestedBudgetUsd: budgetUsd,
    requestedScrapeCompany: config.scrapeCompany,
  },
}];
