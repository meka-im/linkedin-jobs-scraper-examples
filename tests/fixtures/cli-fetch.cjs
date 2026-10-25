const TEST_TOKEN = 'cli-test-token-not-a-real-secret';
const mode = process.env.MEKA_TEST_FETCH_MODE ?? 'success';

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, options = {}) => {
  if (mode === 'no-network') {
    throw new Error('Network access is forbidden in this test');
  }
  if (mode === 'error') {
    throw new Error(
      `Fixture failure: Authorization: Bearer ${process.env.APIFY_TOKEN}; `
      + `raw token ${process.env.APIFY_TOKEN}`,
    );
  }
  if (options.headers?.Authorization !== `Bearer ${TEST_TOKEN}`) {
    throw new Error('Fixture received an unexpected Authorization header');
  }

  const url = new URL(String(input));
  if (options.method === 'POST' && url.pathname.endsWith('/runs')) {
    if (url.searchParams.get('maxTotalChargeUsd') !== '0.05') {
      throw new Error('Fixture did not receive the USD 0.05 charge cap');
    }
    return jsonResponse({
      data: {
        id: `run-cli-${mode}`,
        status: 'SUCCEEDED',
        defaultDatasetId: `dataset-cli-${mode}`,
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
      failedJobDetails: mode === 'partial' ? 2 : 0,
      failedCompanies: 0,
      stoppedByBudget: false,
      cacheHits: 0,
    });
  }

  if (url.pathname === `/v2/datasets/dataset-cli-${mode}/items`) {
    return jsonResponse([{
      id: '4391073032',
      title: 'CLI Test Engineer',
      link: 'https://www.linkedin.com/jobs/view/4391073032',
    }]);
  }

  throw new Error(`Unexpected URL in CLI fixture: ${url.pathname}`);
};
