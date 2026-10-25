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

return [{
  json: {
    keywords: requiredText(config.keywords, 'keywords'),
    location: requiredText(config.location, 'location'),
    datePosted,
    limit: positiveInteger(config.limit, 'limit', 1000),
    budgetUsd,
    scrapeCompany: config.scrapeCompany,
    spreadsheetTitle,
    workflowId,
    workflowIdQuery,
    sheetName: 'Jobs',
    schemaVersion: '1',
  },
}];
