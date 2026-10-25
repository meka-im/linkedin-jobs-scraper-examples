const TEST_TOKEN = 'test-token-not-a-real-secret';

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(String(input));
  if (options.headers?.Authorization !== `Bearer ${TEST_TOKEN}`) {
    throw new Error('Preload fixture received an unexpected Authorization header');
  }

  if (options.method === 'POST' && url.pathname.endsWith('/runs')) {
    return jsonResponse({
      data: {
        id: 'run-cli-partial',
        status: 'SUCCEEDED',
        defaultDatasetId: 'dataset-cli-partial',
      },
    });
  }

  if (url.pathname.endsWith('/key-value-store/records/OUTPUT')) {
    return jsonResponse({
      status: 'completed',
      delivered: 1,
      uniqueJobs: 1,
      searchPages: 1,
      failedSearches: 0,
      failedJobDetails: 2,
      failedCompanies: 0,
      stoppedByBudget: false,
      cacheHits: 0,
    });
  }

  if (url.pathname === '/v2/datasets/dataset-cli-partial/items') {
    return jsonResponse([{
      id: '4391073032',
      title: 'Partial Coverage Engineer',
      link: 'https://www.linkedin.com/jobs/view/4391073032',
    }]);
  }

  throw new Error(`Unexpected URL in CLI fixture: ${url.pathname}`);
};
