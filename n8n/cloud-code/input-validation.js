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

const limit = positiveInteger(config.limit, 'limit', 1000);
const sheetId = requiredText(config.sheetId, 'sheetId');
if (!/^[A-Za-z0-9_-]{2,}$/u.test(sheetId)) {
  throw new Error('sheetId must be the Google Sheets document ID');
}
const workflowId = requiredText(config.workflowId, 'workflowId');
const executionMode = requiredText(config.executionMode, 'executionMode');
if (executionMode !== 'test' && executionMode !== 'production') {
  throw new Error('executionMode must be either test or production');
}
const manualRun = executionMode === 'test';
if (typeof config.manualRun !== 'boolean' || config.manualRun !== manualRun) {
  throw new Error('manualRun must match executionMode');
}
if (
  manualRun
  && (
    limit > 10
    || budgetUsd > 1
    || config.scrapeCompany !== false
  )
) {
  throw new Error('Manual tests must stay within the reviewed 10-job, $1, no-enrichment limit');
}
if (
  !Number.isInteger(config.requestedLimit)
  || !Number.isFinite(config.requestedBudgetUsd)
  || typeof config.requestedScrapeCompany !== 'boolean'
) {
  throw new Error('Input Validation is missing requested-run settings');
}

return [{
  json: {
    keywords: requiredText(config.keywords, 'keywords'),
    location: requiredText(config.location, 'location'),
    datePosted,
    limit,
    count: limit,
    limitPerSource: limit,
    scrapeCompany: config.scrapeCompany,
    budgetUsd,
    sheetId,
    sheetName: requiredText(config.sheetName, 'sheetName'),
    spreadsheetTitle: requiredText(config.spreadsheetTitle, 'spreadsheetTitle'),
    workflowId,
    schemaVersion: requiredText(config.schemaVersion, 'schemaVersion'),
    executionMode,
    manualRun,
    requestedLimit: config.requestedLimit,
    requestedBudgetUsd: config.requestedBudgetUsd,
    requestedScrapeCompany: config.requestedScrapeCompany,
    actorTimeoutSeconds: 300,
    waitForFinishSeconds: 60,
    pollDelaySeconds: 5,
    maxPollAttempts: 6,
    runDeadlineEpochMs: Date.now() + 480_000,
  },
}];
