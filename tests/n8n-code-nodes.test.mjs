import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeN8nCode,
  job,
  loadWorkflow,
  nodeByName,
  settings,
} from './helpers.mjs';

let workflow;
test.before(async () => {
  workflow = await loadWorkflow();
});

const codeNode = (name) => nodeByName(workflow, name).parameters.jsCode;

test('Input Validation keeps the public settings and adds finite run controls', async () => {
  const output = await executeN8nCode(codeNode('Input Validation'), {
    input: [{
      keywords: 'software engineer',
      location: 'London, United Kingdom',
      datePosted: 'pastWeek',
      limit: 25,
      budgetUsd: 0.05,
      scrapeCompany: false,
      sheetId: 'abc_123',
      sheetName: 'Jobs',
    }],
  });

  assert.equal(output.length, 1);
  assert.equal(output[0].json.limit, 25);
  assert.equal(output[0].json.limitPerSource, 25);
  assert.equal(output[0].json.runDeadlineEpochMs > Date.now(), true);
  assert.equal(output[0].json.scrapeCompany, false);
});

test('Input Validation rejects a missing sheet ID and an invalid date window', async () => {
  await assert.rejects(
    executeN8nCode(codeNode('Input Validation'), {
      input: [{
        keywords: 'engineer',
        location: 'London',
        datePosted: 'pastWeek',
        limit: 25,
        budgetUsd: 0.05,
        sheetId: '',
        sheetName: 'Jobs',
      }],
    }),
    /sheetId/,
  );

  await assert.rejects(
    executeN8nCode(codeNode('Input Validation'), {
      input: [{
        keywords: 'engineer',
        location: 'London',
        datePosted: 'yesterday',
        limit: 25,
        budgetUsd: 0.05,
        sheetId: 'sheet_123',
        sheetName: 'Jobs',
      }],
    }),
    /datePosted/,
  );
});

test('start and poll assessment preserve run state and route only SUCCEEDED to fetch', async () => {
  const running = await executeN8nCode(codeNode('Assess Start Run'), {
    input: [{
      body: {
        data: { id: 'run-1', status: 'RUNNING', defaultDatasetId: 'dataset-1' },
      },
    }],
    named: { 'Input Validation': [settings] },
  });
  assert.equal(running[0].json.nextAction, 'poll');
  assert.equal(running[0].json.runId, 'run-1');
  assert.equal(running[0].json.status, 'RUNNING');
  assert.equal(running[0].json.runDeadlineEpochMs, settings.runDeadlineEpochMs);

  const succeeded = await executeN8nCode(codeNode('Assess Polled Run'), {
    input: [{
      body: {
        data: { id: 'run-1', status: 'SUCCEEDED', defaultDatasetId: 'dataset-1' },
      },
    }],
    named: {
      'Input Validation': [settings],
      'Wait for Actor': [{ ...settings, runId: 'run-1', datasetId: 'dataset-1', pollCount: 1 }],
    },
  });
  assert.equal(succeeded[0].json.nextAction, 'fetch');
  assert.equal(succeeded[0].json.pollCount, 2);
});

test('failed, aborted, timed-out, and locally timed-out runs fail with the run ID', async () => {
  for (const status of ['FAILED', 'TIMED-OUT', 'ABORTED']) {
    await assert.rejects(
      executeN8nCode(codeNode('Assess Start Run'), {
        input: [{ body: { data: { id: `run-${status}`, status } } }],
        named: { 'Input Validation': [settings] },
      }),
      new RegExp(`run-${status}.*${status}|${status}.*run-${status}`, 'i'),
    );
  }

  await assert.rejects(
    executeN8nCode(codeNode('Assess Polled Run'), {
      input: [{ body: { data: { id: 'run-deadline', status: 'RUNNING' } } }],
      named: {
        'Input Validation': [{ ...settings, runDeadlineEpochMs: 0 }],
        'Wait for Actor': [{
          ...settings,
          runId: 'run-deadline',
          datasetId: 'dataset-deadline',
          pollCount: 0,
        }],
      },
    }),
    /run-deadline.*deadline/i,
  );
});

const cleanActorSummary = {
  status: 'completed',
  delivered: 0,
  uniqueJobs: 0,
  searchPages: 1,
  failedSearches: 0,
  failedJobDetails: 0,
  failedCompanies: 0,
  stoppedByBudget: false,
  cacheHits: 0,
};

test('Assess Run Output accepts complete runs and preserves the latest run state', async () => {
  const output = await executeN8nCode(codeNode('Assess Run Output'), {
    input: [{ body: cleanActorSummary }],
    named: {
      'Is Run Succeeded?': [{
        ...settings,
        runId: 'run-output',
        datasetId: 'dataset-output',
        status: 'SUCCEEDED',
        pollCount: 2,
      }],
    },
  });
  assert.equal(output[0].json.pollCount, 2);
  assert.equal(output[0].json.coverage, 'complete');
  assert.equal(output[0].json.actorSummary.failedSearches, 0);
});

test('Assess Run Output fails on any failed search', async () => {
  await assert.rejects(
    executeN8nCode(codeNode('Assess Run Output'), {
      input: [{ body: { ...cleanActorSummary, failedSearches: 1 } }],
      named: {
        'Is Run Succeeded?': [{
          ...settings,
          runId: 'run-failed-search',
          datasetId: 'dataset-failed-search',
          status: 'SUCCEEDED',
        }],
      },
    }),
    /run-failed-search.*failed search/,
  );
});

test('Assess Run Output marks failed details and budget stops as partial', async () => {
  const detailFailure = await executeN8nCode(codeNode('Assess Run Output'), {
    input: [{ body: { ...cleanActorSummary, failedJobDetails: 2 } }],
    named: {
      'Is Run Succeeded?': [{
        ...settings,
        runId: 'run-partial',
        datasetId: 'dataset-partial',
        status: 'SUCCEEDED',
      }],
    },
  });
  assert.equal(detailFailure[0].json.coverage, 'partial');

  const budgetStop = await executeN8nCode(codeNode('Assess Run Output'), {
    input: [{ body: { ...cleanActorSummary, stoppedByBudget: true } }],
    named: {
      'Is Run Succeeded?': [{
        ...settings,
        runId: 'run-budget',
        datasetId: 'dataset-budget',
        status: 'SUCCEEDED',
      }],
    },
  });
  assert.equal(budgetStop[0].json.coverage, 'partial');
});

test('Normalize Jobs turns an empty full-response body into one wrapper item', async () => {
  const output = await executeN8nCode(codeNode('Normalize Jobs'), {
    input: [{ body: [], statusCode: 200 }],
    named: {
      'Assess Run Output': [{
        ...settings,
        runId: 'run-empty',
        datasetId: 'dataset-empty',
        status: 'SUCCEEDED',
        actorSummary: cleanActorSummary,
        coverage: 'complete',
      }],
    },
  });

  assert.deepEqual(output, [{
    json: {
      jobs: [],
      runId: 'run-empty',
      datasetId: 'dataset-empty',
      status: 'SUCCEEDED',
      count: 25,
      sheetId: 'test_sheet_id',
      sheetName: 'Jobs',
      actorSummary: cleanActorSummary,
      coverage: 'complete',
      fetchedCount: 0,
    },
  }]);
});

test('embedded Code-node tests run without a URL global', async () => {
  const output = await executeN8nCode(
    "return [{ json: { urlGlobalType: typeof URL } }];",
  );
  assert.equal(output[0].json.urlGlobalType, 'undefined');
});

test('Normalize Jobs rejects a malformed public result instead of silently dropping it', async () => {
  await assert.rejects(
    executeN8nCode(codeNode('Normalize Jobs'), {
      input: [{
        body: [{ id: '1', title: 'Engineer', link: 'https://example.com/jobs/view/1' }],
      }],
      named: {
        'Assess Run Output': [{
          ...settings,
          runId: 'run-invalid',
          datasetId: 'dataset-invalid',
          status: 'SUCCEEDED',
          actorSummary: cleanActorSummary,
          coverage: 'complete',
        }],
      },
    }),
    /public LinkedIn HTTPS (?:URL|authority)/,
  );
});

test('Normalize Jobs accepts percent-encoded and Unicode LinkedIn slug URLs', async () => {
  const slugUrls = [
    {
      id: '1001',
      url: 'https://uk.linkedin.com/jobs/view/software-engineer-at-example-1001?trk=public_jobs',
    },
    {
      id: '4391073032',
      url: 'https://www.linkedin.com/jobs/view/ing%C3%A9nieur-logiciel-4391073032',
    },
    {
      id: '4391073033',
      url: 'https://www.linkedin.com/jobs/view/ingénieur-logiciel-4391073033',
    },
    {
      id: '4391073034',
      url: 'https://www.linkedin.com/jobs/view/ing%C3%A9nieur-logiciel-4391073034?keywords=software%20engineer',
    },
    {
      id: '4391073035',
      url: 'https://www.linkedin.com/jobs/view/software%20engineer-4391073035',
    },
  ];

  for (const { id, url } of slugUrls) {
    const output = await executeN8nCode(codeNode('Normalize Jobs'), {
      input: [{
        body: [{ id, title: 'Engineer', link: url }],
      }],
      named: {
        'Assess Run Output': [{
          ...settings,
          runId: `run-slug-${id}`,
          datasetId: `dataset-slug-${id}`,
          status: 'SUCCEEDED',
          actorSummary: cleanActorSummary,
          coverage: 'complete',
        }],
      },
    });

    assert.equal(output[0].json.jobs[0].url, url);
    assert.equal(output[0].json.jobs[0].id, id);
  }
});

test('Normalize Jobs rejects malformed, misleading, and mismatched LinkedIn URLs', async () => {
  const invalidLinks = [
    'http://www.linkedin.com/jobs/view/1',
    'https://www.linkedin.com@evil.example/jobs/view/1',
    'https://www.linkedin.com.evil.example/jobs/view/1',
    'https://www.linkedin.com:443/jobs/view/1',
    'https://www.linkedin.com/jobs/view/1\\@evil.example',
    'https://www.linkedin.com/jobs/view/1 2',
    'https://www.linkedin.com/jobs/view/',
    'https://www.linkedin.com/jobs/view/ing%C3%A9nieur%2G-1',
    'https://www.linkedin.com/jobs/view/engineer%5Cjob-1',
    'https://www.linkedin.com/jobs/view/engineer%00job-1',
    'https://www.linkedin.com/jobs/view/engineer-\u0000-1',
    'https://www.linkedin.com/jobs/view/engineer-\u001f-1',
    'https://www.linkedin.com/jobs/view/engineer-at-example-2',
  ];

  for (const link of invalidLinks) {
    await assert.rejects(
      executeN8nCode(codeNode('Normalize Jobs'), {
        input: [{
          body: [{ id: '1', title: 'Engineer', link }],
        }],
        named: {
          'Assess Run Output': [{
            ...settings,
            runId: 'run-invalid-link',
            datasetId: 'dataset-invalid-link',
            status: 'SUCCEEDED',
            actorSummary: cleanActorSummary,
            coverage: 'complete',
          }],
        },
      }),
      /invalid link|unsafe percent-encoded|public LinkedIn HTTPS URL|public LinkedIn HTTPS authority|non-empty job slug|does not match/,
    );
  }
});

async function filterJobs(jobs, existingRows = []) {
  return executeN8nCode(codeNode('Filter New IDs'), {
    input: existingRows,
    named: {
      'Normalize Jobs': [{
        jobs,
        runId: 'run-filter',
        datasetId: 'dataset-filter',
        actorSummary: cleanActorSummary,
        coverage: 'complete',
        fetchedCount: jobs.length,
      }],
    },
  });
}

test('empty sheet accepts the first batch', async () => {
  const [output] = await filterJobs([job(1), job(2)]);
  assert.deepEqual(output.json.newJobs.map(({ id }) => id), ['1', '2']);
  assert.equal(output.json.summary.fetchedCount, 2);
  assert.equal(output.json.summary.newCount, 2);
});

test('second identical batch produces a normal zero-new summary', async () => {
  const [output] = await filterJobs([job(1), job(2)], [job(1), job(2)]);
  assert.deepEqual(output.json.newJobs, []);
  assert.equal(output.json.summary.newCount, 0);
  assert.equal(output.json.summary.skippedExisting, 2);
  assert.equal(output.json.hasNewJobs, false);
});

test('mixed old and new jobs append only the new IDs', async () => {
  const [output] = await filterJobs([job(1), job(2), job(3)], [job(2)]);
  assert.deepEqual(output.json.newJobs.map(({ id }) => id), ['1', '3']);
  assert.equal(output.json.summary.skippedExisting, 1);
});

test('batch duplicates are deduplicated without another sheet write', async () => {
  const [output] = await filterJobs([job(1), job(1), job(2)]);
  assert.deepEqual(output.json.newJobs.map(({ id }) => id), ['1', '2']);
  assert.equal(output.json.summary.skippedBatchDuplicates, 1);
});

test('empty read placeholders are skipped while non-empty rows without id fail', async () => {
  const firstBatch = await filterJobs([job(1)], [{
    row_number: 2,
  }]);
  assert.deepEqual(firstBatch[0].json.newJobs.map(({ id }) => id), ['1']);

  await assert.rejects(
    filterJobs([job(1)], [{
      row_number: 2,
      title: 'A row with a broken schema',
    }]),
    /Existing sheet row 2 has data but no id/,
  );
});

test('Filter New IDs rejects invalid public result records', async () => {
  await assert.rejects(
    filterJobs([job(1, { url: 'https://example.com/jobs/view/1' })]),
    /public LinkedIn HTTPS (?:URL|authority)/,
  );
  await assert.rejects(
    filterJobs([job('not-numeric')]),
    /invalid id/,
  );
  await assert.rejects(
    filterJobs([job(1, { title: '' })]),
    /missing title/,
  );
});

test('Filter New IDs accepts localized slug URLs and rejects unsafe authorities', async () => {
  const slugJob = job(3, {
    url: 'https://www.linkedin.com/jobs/view/ing%C3%A9nieur-logiciel-3',
  });
  const [output] = await filterJobs([slugJob]);
  assert.deepEqual(output.json.newJobs.map(({ id }) => id), ['3']);

  const unicodeJob = job(4, {
    url: 'https://www.linkedin.com/jobs/view/développeur-logiciel-4',
  });
  const [unicodeOutput] = await filterJobs([unicodeJob]);
  assert.deepEqual(unicodeOutput.json.newJobs.map(({ id }) => id), ['4']);

  const encodedSpaceJob = job(5, {
    url: 'https://www.linkedin.com/jobs/view/software%20engineer-5?keywords=software%20engineer',
  });
  const [encodedSpaceOutput] = await filterJobs([encodedSpaceJob]);
  assert.deepEqual(encodedSpaceOutput.json.newJobs.map(({ id }) => id), ['5']);

  for (const url of [
    'https://user@www.linkedin.com/jobs/view/3',
    'https://www.linkedin.com:444/jobs/view/3',
  ]) {
    await assert.rejects(
      filterJobs([job(3, { url })]),
      /invalid link|public LinkedIn HTTPS URL|public LinkedIn HTTPS authority/,
    );
  }
});

test('Run Summary reports success for both append and zero-new paths', async () => {
  const appended = await executeN8nCode(codeNode('Run Summary'), {
    named: {
      'Filter New IDs': [{
        summary: {
          runId: 'run-1',
          datasetId: 'dataset-1',
          actorSummary: cleanActorSummary,
          coverage: 'complete',
          fetchedCount: 3,
          newCount: 2,
          skippedExisting: 1,
          skippedBatchDuplicates: 0,
          hasNewJobs: true,
        },
      }],
    },
  });
  assert.equal(appended[0].json.appendedCount, 2);

  const empty = await executeN8nCode(codeNode('Run Summary'), {
    named: {
      'Filter New IDs': [{
        summary: {
          runId: 'run-2',
          datasetId: 'dataset-2',
          actorSummary: cleanActorSummary,
          coverage: 'complete',
          fetchedCount: 0,
          newCount: 0,
          skippedExisting: 0,
          skippedBatchDuplicates: 0,
          hasNewJobs: false,
        },
      }],
    },
  });
  assert.equal(empty[0].json.appendedCount, 0);
  assert.match(empty[0].json.message, /No unseen IDs.*fetched batch/);

  const partial = await executeN8nCode(codeNode('Run Summary'), {
    named: {
      'Filter New IDs': [{
        summary: {
          runId: 'run-partial',
          datasetId: 'dataset-partial',
          actorSummary: { ...cleanActorSummary, stoppedByBudget: true },
          coverage: 'partial',
          fetchedCount: 0,
          newCount: 0,
          skippedExisting: 0,
          skippedBatchDuplicates: 0,
          hasNewJobs: false,
        },
      }],
    },
  });
  assert.match(partial[0].json.message, /does not establish that no matching jobs/);
});
