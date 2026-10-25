import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { runLinkedInJobs } from '../src/apify-client.mjs';

async function withMockServer(handler, callback) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    try {
      await handler(request, response, body);
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await callback({
      requests,
      apiBaseUrl: `http://127.0.0.1:${port}`,
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function json(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

const validInput = {
  keywords: 'software engineer',
  location: 'London, United Kingdom',
  datePosted: 'pastWeek',
  count: 10,
  limitPerSource: 10,
  scrapeCompany: false,
};

const cleanSummary = {
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

test('one POST is followed by bounded status polls and an empty dataset remains successful', async () => {
  let polls = 0;
  await withMockServer(async (request, response) => {
    if (request.method === 'POST') {
      json(response, 201, {
        data: { id: 'run-mock', status: 'RUNNING', defaultDatasetId: 'dataset-mock' },
      });
      return;
    }
    if (request.url === '/v2/actor-runs/run-mock?waitForFinish=60') {
      polls += 1;
      json(response, 200, {
        data: {
          id: 'run-mock',
          status: polls === 1 ? 'RUNNING' : 'SUCCEEDED',
          defaultDatasetId: 'dataset-mock',
        },
      });
      return;
    }
    if (request.url === '/v2/actor-runs/run-mock/key-value-store/records/OUTPUT') {
      json(response, 200, cleanSummary);
      return;
    }
    if (request.url === '/v2/datasets/dataset-mock/items?format=json&clean=true&limit=10') {
      json(response, 200, []);
      return;
    }
    throw new Error(`unexpected route ${request.method} ${request.url}`);
  }, async ({ requests, apiBaseUrl }) => {
    const result = await runLinkedInJobs({
      token: 'test-token-not-a-real-secret',
      apiBaseUrl,
      input: validInput,
      pollDelayMs: 0,
      sleepFn: async () => {},
    });

    assert.equal(result.runId, 'run-mock');
    assert.equal(result.status, 'SUCCEEDED');
    assert.deepEqual(result.jobs, []);
    assert.equal(result.summary.coverage, 'complete');
    assert.equal(requests.filter(({ method }) => method === 'POST').length, 1);
    assert.deepEqual(
      requests.map(({ method }) => method),
      ['POST', 'GET', 'GET', 'GET', 'GET'],
    );
    assert.equal(
      requests[0].url,
      '/v2/acts/meka.im~linkedin-jobs-scraper/runs?memory=512&timeout=300&maxTotalChargeUsd=0.05&waitForFinish=60',
    );
    assert.equal(
      requests.every(({ headers }) => headers.authorization === 'Bearer test-token-not-a-real-secret'),
      true,
    );
    assert.equal(
      requests.every(({ url }) => !url.includes('test-token-not-a-real-secret')),
      true,
    );
    assert.deepEqual(JSON.parse(requests[0].body), validInput);
  });
});

test('invalid input is rejected before any POST', async () => {
  await withMockServer(async () => {
    throw new Error('server should not receive a request');
  }, async ({ requests, apiBaseUrl }) => {
    await assert.rejects(
      runLinkedInJobs({
        token: 'private-token-value',
        apiBaseUrl,
        input: { ...validInput, count: 0 },
        sleepFn: async () => {},
      }),
      /input\.count must be a positive integer/,
    );
    assert.equal(requests.length, 0);
  });
});

test('a failed start request is not retried and the token is not included in the error', async () => {
  await withMockServer(async (_request, response) => {
    json(response, 500, { error: { message: 'upstream failed' } });
  }, async ({ requests, apiBaseUrl }) => {
    await assert.rejects(
      runLinkedInJobs({
        token: 'private-token-value',
        apiBaseUrl,
        input: validInput,
        sleepFn: async () => {},
      }),
      (error) => {
        assert.match(error.message, /HTTP 500/);
        assert.doesNotMatch(error.message, /private-token-value/);
        return true;
      },
    );
    assert.equal(requests.filter(({ method }) => method === 'POST').length, 1);
  });
});

test('terminal API statuses fail without fetching dataset items', async () => {
  for (const status of ['FAILED', 'TIMED-OUT', 'ABORTED']) {
    await withMockServer(async (_request, response) => {
      json(response, 201, { data: { id: `run-${status}`, status } });
    }, async ({ requests, apiBaseUrl }) => {
      await assert.rejects(
        runLinkedInJobs({
          token: 'test-token',
          apiBaseUrl,
          input: validInput,
          sleepFn: async () => {},
        }),
        new RegExp(`run-${status}.*${status}`),
      );
      assert.equal(requests.length, 1);
    });
  }
});

test('poll exhaustion reports the run ID for recovery', async () => {
  await withMockServer(async (_request, response) => {
    json(response, 201, {
      data: { id: 'run-timeout', status: 'RUNNING', defaultDatasetId: 'dataset-timeout' },
    });
  }, async ({ apiBaseUrl }) => {
    await assert.rejects(
      runLinkedInJobs({
        token: 'test-token',
        apiBaseUrl,
        input: validInput,
        maxPollAttempts: 0,
        sleepFn: async () => {},
      }),
      /run-timeout.*Recovery run ID: run-timeout/,
    );
  });
});

test('failed searches fail before fetching the dataset', async () => {
  await withMockServer(async (request, response) => {
    if (request.method === 'POST') {
      json(response, 201, {
        data: {
          id: 'run-search-failed',
          status: 'SUCCEEDED',
          defaultDatasetId: 'dataset-search-failed',
        },
      });
      return;
    }
    if (request.url.endsWith('/records/OUTPUT')) {
      json(response, 200, { ...cleanSummary, failedSearches: 1 });
      return;
    }
    throw new Error(`dataset should not be fetched: ${request.url}`);
  }, async ({ requests, apiBaseUrl }) => {
    await assert.rejects(
      runLinkedInJobs({
        token: 'test-token',
        apiBaseUrl,
        input: validInput,
        sleepFn: async () => {},
      }),
      /run-search-failed.*failed search/,
    );
    assert.deepEqual(
      requests.map(({ method }) => method),
      ['POST', 'GET'],
    );
  });
});

test('a budget-stopped success remains successful but is returned as partial', async () => {
  await withMockServer(async (request, response) => {
    if (request.method === 'POST') {
      json(response, 201, {
        data: {
          id: 'run-budget',
          status: 'SUCCEEDED',
          defaultDatasetId: 'dataset-budget',
        },
      });
      return;
    }
    if (request.url.endsWith('/records/OUTPUT')) {
      json(response, 200, { ...cleanSummary, stoppedByBudget: true });
      return;
    }
    if (request.url.includes('/v2/datasets/dataset-budget/items?')) {
      json(response, 200, []);
      return;
    }
    throw new Error(`unexpected route ${request.url}`);
  }, async ({ apiBaseUrl }) => {
    const result = await runLinkedInJobs({
      token: 'test-token',
      apiBaseUrl,
      input: validInput,
      sleepFn: async () => {},
    });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.summary.stoppedByBudget, true);
    assert.equal(result.summary.coverage, 'partial');
    assert.deepEqual(result.jobs, []);
  });
});
