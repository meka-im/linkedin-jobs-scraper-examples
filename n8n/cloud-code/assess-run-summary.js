const response = $input.first()?.json ?? {};
const filtered = $('Filter New IDs').first()?.json ?? {};
const config = $('Input Validation').first()?.json ?? {};
const summary = filtered.summary;

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

function text(value) {
  return value == null ? '' : String(value);
}

function plainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function invalidSummary(failureCategory) {
  return [{
    json: {
      workflowId: String($workflow?.id ?? ''),
      executionId: String($execution?.id ?? ''),
      status: 'invalid-summary',
      testPassed: false,
      failureCategory,
      fetchedCount: null,
      newCount: null,
      appendedCount: null,
      skippedExisting: null,
      skippedBatchDuplicates: null,
      failedSearches: null,
      failedJobDetails: null,
      failedCompanies: null,
      budgetStopped: null,
      coverage: null,
      readbackVerified: false,
      previousRowsUnchanged: false,
      allFieldsPresent: false,
      firstSeenAtPresent: false,
      uniqueIds: false,
      manualRun: config.manualRun === true,
      manualLimit: null,
      manualBudgetUsd: null,
      companyEnrichmentDisabled: false,
      executionMode: typeof config.executionMode === 'string'
        ? config.executionMode
        : 'unknown',
    },
  }];
}

if (
  !['test', 'production'].includes(config.executionMode)
  || typeof config.manualRun !== 'boolean'
  || config.manualRun !== (config.executionMode === 'test')
  || !nonNegativeInteger(config.limit)
  || config.limit < 1
  || !Number.isFinite(config.budgetUsd)
  || config.budgetUsd <= 0
  || typeof config.scrapeCompany !== 'boolean'
) {
  return invalidSummary('invalid-manual-settings');
}
if (
  config.executionMode === 'test'
  && (
    config.limit > 10
    || config.budgetUsd > 0.05
    || config.scrapeCompany !== false
  )
) {
  return invalidSummary('invalid-manual-settings');
}

if (!plainObject(summary) || !plainObject(summary.actorSummary)) {
  return invalidSummary('invalid-run-summary');
}
if (
  !nonNegativeInteger(summary.fetchedCount)
  || !nonNegativeInteger(summary.newCount)
  || !nonNegativeInteger(summary.skippedExisting)
  || !nonNegativeInteger(summary.skippedBatchDuplicates)
  || !nonNegativeInteger(summary.actorSummary.failedSearches)
  || !nonNegativeInteger(summary.actorSummary.failedJobDetails)
  || !nonNegativeInteger(summary.actorSummary.failedCompanies)
  || typeof summary.actorSummary.stoppedByBudget !== 'boolean'
  || !['complete', 'partial'].includes(summary.coverage)
  || !Array.isArray(filtered.newJobs)
) {
  return invalidSummary('invalid-run-summary');
}
if (
  summary.newCount !== filtered.newJobs.length
  || summary.fetchedCount !== (
    summary.newCount
    + summary.skippedExisting
    + summary.skippedBatchDuplicates
  )
) {
  return invalidSummary('invalid-run-summary');
}

const budgetStopped = summary.actorSummary.stoppedByBudget;
const failureCounts = (
  summary.actorSummary.failedSearches
  + summary.actorSummary.failedJobDetails
  + summary.actorSummary.failedCompanies
);
if (
  (summary.coverage === 'partial'
    && failureCounts === 0
    && budgetStopped !== true)
  || (summary.coverage === 'complete'
    && (failureCounts > 0 || budgetStopped))
) {
  return invalidSummary('invalid-run-summary');
}

const baseSummary = {
  workflowId: String($workflow?.id ?? ''),
  executionId: String($execution?.id ?? ''),
  fetchedCount: summary.fetchedCount,
  newCount: summary.newCount,
  skippedExisting: summary.skippedExisting,
  skippedBatchDuplicates: summary.skippedBatchDuplicates,
  failedSearches: summary.actorSummary.failedSearches,
  failedJobDetails: summary.actorSummary.failedJobDetails,
  failedCompanies: summary.actorSummary.failedCompanies,
  budgetStopped,
  coverage: summary.coverage,
  manualRun: config.manualRun,
  manualLimit: config.limit,
  manualBudgetUsd: config.budgetUsd,
  companyEnrichmentDisabled: config.manualRun && config.scrapeCompany === false,
  executionMode: config.executionMode,
};

function writeUnverified(failureCategory) {
  return [{
    json: {
      ...baseSummary,
      status: 'write-unverified',
      testPassed: false,
      failureCategory,
      appendedCount: -1,
      readbackVerified: false,
      previousRowsUnchanged: false,
      allFieldsPresent: false,
      firstSeenAtPresent: false,
      uniqueIds: false,
    },
  }];
}

const statusCode = Number(response.statusCode);
if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
  return writeUnverified('sheet-read-failed');
}

let body = response.body !== undefined ? response.body : response;
if (typeof body === 'string') {
  try {
    body = JSON.parse(body);
  } catch {
    return writeUnverified('sheet-read-invalid-json');
  }
}
if (!plainObject(body) || !Array.isArray(body.values) || body.values.length === 0) {
  return writeUnverified('sheet-read-invalid-rows');
}

const header = Array.isArray(body.values[0])
  ? body.values[0].map(text)
  : [];
if (
  header.length !== expectedHeader.length
  || header.some((value, index) => value !== expectedHeader[index])
) {
  return writeUnverified('sheet-readback-header-mismatch');
}

function normalizedValues(values) {
  return expectedHeader.map((_, index) => text(values?.[index]));
}

function rowIsEmpty(values) {
  return values.every((value) => value.trim() === '');
}

const priorRows = $('Read Existing Jobs').all()
  .map((item) => {
    const row = item?.json ?? {};
    return expectedHeader.map((name) => text(row[name]));
  })
  .filter((values) => !rowIsEmpty(values));
const currentRows = body.values
  .slice(1)
  .map(normalizedValues)
  .filter((values) => !rowIsEmpty(values));

if (currentRows.length < priorRows.length) {
  return writeUnverified('sheet-readback-removed-rows');
}
const previousRowsUnchanged = priorRows.every((row, index) => (
  currentRows[index].every((value, column) => value === row[column])
));
if (!previousRowsUnchanged) {
  return writeUnverified('sheet-readback-changed-prior-rows');
}

const seenIds = new Set();
let uniqueIds = true;
let idsPresent = true;
for (const row of currentRows) {
  const id = row[0].trim();
  if (!id) idsPresent = false;
  if (seenIds.has(id)) uniqueIds = false;
  seenIds.add(id);
}
uniqueIds = uniqueIds && idsPresent;

const appendedRows = currentRows.slice(priorRows.length);
if (appendedRows.length !== filtered.newJobs.length) {
  return writeUnverified('sheet-readback-count-mismatch');
}

let allFieldsPresent = true;
let firstSeenAtPresent = true;
const expectedIds = [];
for (const [index, job] of filtered.newJobs.entries()) {
  const row = appendedRows[index];
  const sourceRow = body.values.slice(1).filter(
    (values) => !rowIsEmpty(normalizedValues(values)),
  )[priorRows.length + index];
  const expectedRow = expectedHeader.map((name) => text(job?.[name]));
  expectedIds.push(expectedRow[0]);
  if (
    row.some((value, column) => value !== expectedRow[column])
    || (Array.isArray(sourceRow) && sourceRow.length > expectedHeader.length)
  ) {
    allFieldsPresent = false;
  }
  if (
    !row[9].trim()
    || row[9] !== expectedRow[9]
    || !Number.isFinite(Date.parse(row[9]))
  ) {
    firstSeenAtPresent = false;
  }
}

const expectedIdsUnique = (
  expectedIds.every((id) => /^[0-9]+$/.test(id))
  && new Set(expectedIds).size === expectedIds.length
);
const everyAppendedIdVisible = expectedIds.every((id) => seenIds.has(id));
const readbackVerified = (
  appendedRows.length > 0
  && previousRowsUnchanged
  && allFieldsPresent
  && firstSeenAtPresent
  && uniqueIds
  && expectedIdsUnique
  && everyAppendedIdVisible
);

let status;
let failureCategory = null;
let testPassed = false;
if (appendedRows.length === 0) {
  status = 'no-new-rows';
  failureCategory = budgetStopped ? 'budget-stopped' : 'no-new-rows';
} else if (summary.coverage === 'partial' || budgetStopped) {
  status = 'partial';
  failureCategory = budgetStopped ? 'budget-stopped' : 'partial-run';
} else if (!readbackVerified) {
  status = 'write-unverified';
  failureCategory = 'write-readback-mismatch';
} else if (config.executionMode === 'test') {
  status = 'passed';
  testPassed = true;
} else {
  status = 'production-complete';
}

return [{
  json: {
    ...baseSummary,
    status,
    testPassed,
    failureCategory,
    appendedCount: appendedRows.length,
    readbackVerified,
    previousRowsUnchanged,
    allFieldsPresent,
    firstSeenAtPresent,
    uniqueIds: uniqueIds && expectedIdsUnique,
  },
}];
