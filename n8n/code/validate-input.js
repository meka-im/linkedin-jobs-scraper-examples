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

const limit = positiveInteger(config.limit, 'limit', 1000);
const sheetId = requiredText(config.sheetId, 'sheetId');
if (!/^[A-Za-z0-9_-]{2,}$/.test(sheetId)) {
  throw new Error('sheetId must be the Google Sheets document ID');
}

return [{
  json: {
    keywords: requiredText(config.keywords, 'keywords'),
    location: requiredText(config.location, 'location'),
    datePosted,
    limit,
    count: limit,
    limitPerSource: limit,
    scrapeCompany: config.scrapeCompany === true,
    budgetUsd,
    sheetId,
    sheetName: requiredText(config.sheetName, 'sheetName'),
    actorTimeoutSeconds: 300,
    waitForFinishSeconds: 60,
    pollDelaySeconds: 5,
    maxPollAttempts: 6,
    runDeadlineEpochMs: Date.now() + 480_000,
  },
}];
