const filtered = $('Filter New IDs').first()?.json ?? {};
const summary = filtered.summary;
if (!summary || typeof summary !== 'object') {
  throw new Error('Filter New IDs did not produce a summary');
}

const appendedCount = summary.hasNewJobs ? summary.newCount : 0;
const partial = summary.coverage === 'partial';
let message;
if (appendedCount && partial) {
  message = `Appended ${appendedCount} new job(s) from a partial Actor run. Inspect the warning counters.`;
} else if (appendedCount) {
  message = `Appended ${appendedCount} new job(s) after deduplication.`;
} else if (partial) {
  message = 'No new delivered jobs were appended, but the Actor run was partial; this does not establish that no matching jobs were posted.';
} else {
  message = 'No unseen IDs were found in this fetched batch; no rows were appended.';
}

return [{
  json: {
    status: 'success',
    runId: summary.runId,
    datasetId: summary.datasetId,
    fetchedCount: summary.fetchedCount,
    newCount: summary.newCount,
    appendedCount,
    skippedExisting: summary.skippedExisting,
    skippedBatchDuplicates: summary.skippedBatchDuplicates,
    coverage: summary.coverage,
    actorSummary: summary.actorSummary,
    message,
  },
}];
