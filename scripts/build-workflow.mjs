import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = async (name) => {
  const source = await readFile(path.join(root, 'n8n', 'code', name), 'utf8');
  return `${source.trim()}\n`;
};

const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters,
  id,
  name,
  type: `n8n-nodes-base.${type}`,
  typeVersion,
  position,
  ...extra,
});

const googleDocument = () => ({
  __rl: true,
  mode: 'id',
  value: "={{ $('Input Validation').first().json.sheetId }}",
});

const googleSheet = () => ({
  __rl: true,
  mode: 'name',
  value: "={{ $('Input Validation').first().json.sheetName }}",
});

const schema = [
  ['id', true],
  ['title', false],
  ['company', false],
  ['location', false],
  ['postedAt', false],
  ['url', false],
  ['salary', false],
  ['employmentType', false],
  ['seniority', false],
  ['firstSeenAt', false],
].map(([id, canBeUsedToMatch]) => ({
  id,
  displayName: id,
  required: false,
  defaultMatch: false,
  display: true,
  type: 'string',
  canBeUsedToMatch,
}));

const values = Object.fromEntries(schema.map(({ id }) => [id, `={{ $json.${id} }}`]));

const workflow = {
  name: 'LinkedIn jobs to Google Sheets',
  nodes: [
    node('0f8447af-83f0-4c36-bcad-ea7ae560b153', 'Manual Trigger', 'manualTrigger', 1, [-1180, -180], {}),
    node('bc7d9a5a-d3c3-466b-9e6a-1c1467abed88', 'Daily Schedule', 'scheduleTrigger', 1.2, [-1180, 20], {
      rule: {
        interval: [{
          field: 'days',
          daysInterval: 1,
          triggerAtHour: 8,
          triggerAtMinute: 0,
        }],
      },
    }),
    node('84219f0b-d510-4d5c-bca6-c65a9d61ec1d', 'Before Running', 'stickyNote', 1, [-1180, -680], {
      content: [
        '## Before running',
        '',
        '**Apify credential:** create an HTTP Header Auth credential, or use one you already have. Set **Name** to `Authorization` and **Value** to `Bearer <APIFY_TOKEN>`. Select it on **Start Actor**, **Poll Actor Run**, **Get Run Output**, and **Get Dataset Items**.',
        '',
        '**Google credential:** connect Google Sheets OAuth and select the same credential on **Read Existing Jobs** and **Append Rows**.',
        '',
        'Copy `sheets/jobs-header.csv` into row 1 of a sheet named `Jobs`. In **Search settings**, enter the Google Sheets document ID and set `sheetName` to `Jobs`.',
        '',
        'The workflow exports as inactive. The schedule is 08:00 UTC; change the workflow timezone or trigger time if you need another local time. Activate it only after a manual test succeeds.',
      ].join('\n'),
      width: 800,
      height: 380,
    }),
    node('7f4493f5-7dc8-4887-8b9c-3ca85145c9c2', 'Search settings', 'set', 3.4, [-960, -80], {
      assignments: {
        assignments: [
          { id: '44f182b9-78ab-46fe-96ac-f3ec0e794af3', name: 'keywords', value: 'software engineer', type: 'string' },
          { id: '0aa61d19-4101-4d2d-be3e-a9cf72ad005c', name: 'location', value: 'London, United Kingdom', type: 'string' },
          { id: 'c9941192-8e6b-4143-b606-cd78a9cf18fc', name: 'datePosted', value: 'pastWeek', type: 'string' },
          { id: '2df74e4c-6017-493e-9128-97aa54cd89cc', name: 'limit', value: 25, type: 'number' },
          { id: 'ad409653-f9ab-44db-b786-b0e0b55a21fb', name: 'budgetUsd', value: 0.05, type: 'number' },
          { id: '1f1514b8-7f0b-4f10-935c-66f5a7c21f69', name: 'scrapeCompany', value: false, type: 'boolean' },
          { id: '509a948c-d6d6-4984-8ef1-403fe5c24d88', name: 'sheetId', value: '', type: 'string' },
          { id: 'fdf6bbb6-0e9c-45d1-9aef-2b1628337097', name: 'sheetName', value: 'Jobs', type: 'string' },
        ],
      },
      options: {},
    }),
    node('7acb8a09-d5b8-4620-b511-ea56beacb663', 'Input Validation', 'code', 2, [-720, -80], {
      mode: 'runOnceForAllItems',
      jsCode: await code('validate-input.js'),
    }),
    node('8fb1ea03-539e-42fd-94fe-da51f63eaa9b', 'Start Actor', 'httpRequest', 4.2, [-480, -80], {
      method: 'POST',
      url: 'https://api.apify.com/v2/acts/meka.im~linkedin-jobs-scraper/runs',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'memory', value: '512' },
          { name: 'timeout', value: '={{ $json.actorTimeoutSeconds }}' },
          { name: 'maxTotalChargeUsd', value: '={{ $json.budgetUsd }}' },
          { name: 'waitForFinish', value: '={{ $json.waitForFinishSeconds }}' },
        ],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: '={{ { "keywords": $json.keywords, "location": $json.location, "datePosted": $json.datePosted, "count": $json.count, "limitPerSource": $json.limitPerSource, "scrapeCompany": $json.scrapeCompany } }}',
      options: {
        response: {
          response: {
            fullResponse: true,
            responseFormat: 'json',
          },
        },
        timeout: 70000,
      },
    }, { retryOnFail: false }),
    node('b2923778-6d15-47cd-8b28-8d7088172168', 'Assess Start Run', 'code', 2, [-240, -80], {
      mode: 'runOnceForAllItems',
      jsCode: await code('assess-start-run.js'),
    }),
    node('308807c3-c0b6-44e6-bccb-71f5ebb15262', 'Is Run Succeeded?', 'if', 2.2, [0, -80], {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2,
        },
        conditions: [{
          id: '78e30302-df87-4a13-8a97-3d47481a30a3',
          leftValue: "={{ $json.nextAction === 'fetch' }}",
          rightValue: '',
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true,
          },
        }],
        combinator: 'and',
      },
      options: {},
    }),
    node('2ae61a80-5fc1-435f-9163-95804778d0e0', 'Wait for Actor', 'wait', 1.1, [240, 100], {
      resume: 'timeInterval',
      amount: '={{ $json.pollDelaySeconds }}',
      unit: 'seconds',
      options: {},
    }),
    node('90344a24-f6d2-46ab-a0ec-bc9f15d7ea22', 'Poll Actor Run', 'httpRequest', 4.2, [480, 100], {
      method: 'GET',
      url: "={{ 'https://api.apify.com/v2/actor-runs/' + $json.runId }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [{
          name: 'waitForFinish',
          value: '={{ $json.waitForFinishSeconds }}',
        }],
      },
      options: {
        response: {
          response: {
            fullResponse: true,
            responseFormat: 'json',
          },
        },
        timeout: 70000,
      },
    }, { retryOnFail: false }),
    node('5e894632-3b96-485d-a413-dd70c90d44ce', 'Assess Polled Run', 'code', 2, [720, 100], {
      mode: 'runOnceForAllItems',
      jsCode: await code('assess-polled-run.js'),
    }),
    node('2a31d69a-2e72-47de-8c5d-46db26df32a5', 'Get Run Output', 'httpRequest', 4.2, [240, -80], {
      method: 'GET',
      url: "={{ 'https://api.apify.com/v2/actor-runs/' + $json.runId + '/key-value-store/records/OUTPUT' }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      options: {
        response: {
          response: {
            fullResponse: true,
            responseFormat: 'json',
          },
        },
        timeout: 70000,
      },
    }, { retryOnFail: false }),
    node('a6675562-175f-4e38-903f-8bde3737d687', 'Assess Run Output', 'code', 2, [480, -80], {
      mode: 'runOnceForAllItems',
      jsCode: await code('assess-run-output.js'),
    }),
    node('1d577a21-233a-4a45-9b0c-a20b3f65ec42', 'Get Dataset Items', 'httpRequest', 4.2, [720, -80], {
      method: 'GET',
      url: "={{ 'https://api.apify.com/v2/datasets/' + $json.datasetId + '/items' }}",
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'format', value: 'json' },
          { name: 'clean', value: 'true' },
          { name: 'limit', value: '={{ $json.count }}' },
        ],
      },
      options: {
        response: {
          response: {
            fullResponse: true,
            responseFormat: 'json',
          },
        },
        timeout: 70000,
      },
    }, { retryOnFail: false }),
    node('f2adbd4e-2b09-466a-9990-cb05579bf133', 'Normalize Jobs', 'code', 2, [960, -80], {
      mode: 'runOnceForAllItems',
      jsCode: await code('normalize-jobs.js'),
    }),
    node('ae530c96-97da-46aa-9567-8c339d1ab19d', 'Read Existing Jobs', 'googleSheets', 4.7, [1200, -80], {
      resource: 'sheet',
      operation: 'read',
      documentId: googleDocument(),
      sheetName: googleSheet(),
      options: {},
    }, { alwaysOutputData: true }),
    node('be0ec152-d240-4abe-a128-cf080ac98c3f', 'Filter New IDs', 'code', 2, [1440, -80], {
      mode: 'runOnceForAllItems',
      jsCode: await code('filter-new-ids.js'),
    }),
    node('b92c5a25-59d8-41c2-895a-3557ea0bcbdf', 'Has New Jobs?', 'if', 2.2, [1680, -80], {
      conditions: {
        options: {
          caseSensitive: true,
          leftValue: '',
          typeValidation: 'strict',
          version: 2,
        },
        conditions: [{
          id: 'cb120943-38a5-4509-8669-8e43cd19971e',
          leftValue: '={{ $json.hasNewJobs }}',
          rightValue: '',
          operator: {
            type: 'boolean',
            operation: 'true',
            singleValue: true,
          },
        }],
        combinator: 'and',
      },
      options: {},
    }),
    node('35af0c0c-277e-4aa1-9307-1e5c34646858', 'Split Out New Jobs', 'splitOut', 1, [1920, -180], {
      fieldToSplitOut: 'newJobs',
      options: {},
    }),
    node('7d668f07-2fc2-40c6-a36b-4f4f7ec0b8b3', 'Append Rows', 'googleSheets', 4.7, [2160, -180], {
      resource: 'sheet',
      operation: 'append',
      documentId: googleDocument(),
      sheetName: googleSheet(),
      columns: {
        mappingMode: 'defineBelow',
        value: values,
        schema,
      },
      options: {
        cellFormat: 'RAW',
      },
    }, { retryOnFail: false }),
    node('b98dfa3e-57ea-4f30-a315-69ba678adf60', 'Run Summary', 'code', 2, [2400, -80], {
      mode: 'runOnceForAllItems',
      jsCode: await code('summarize-success.js'),
    }),
  ],
  connections: {
    'Manual Trigger': {
      main: [[{ node: 'Search settings', type: 'main', index: 0 }]],
    },
    'Daily Schedule': {
      main: [[{ node: 'Search settings', type: 'main', index: 0 }]],
    },
    'Search settings': {
      main: [[{ node: 'Input Validation', type: 'main', index: 0 }]],
    },
    'Input Validation': {
      main: [[{ node: 'Start Actor', type: 'main', index: 0 }]],
    },
    'Start Actor': {
      main: [[{ node: 'Assess Start Run', type: 'main', index: 0 }]],
    },
    'Assess Start Run': {
      main: [[{ node: 'Is Run Succeeded?', type: 'main', index: 0 }]],
    },
    'Is Run Succeeded?': {
      main: [
        [{ node: 'Get Run Output', type: 'main', index: 0 }],
        [{ node: 'Wait for Actor', type: 'main', index: 0 }],
      ],
    },
    'Wait for Actor': {
      main: [[{ node: 'Poll Actor Run', type: 'main', index: 0 }]],
    },
    'Poll Actor Run': {
      main: [[{ node: 'Assess Polled Run', type: 'main', index: 0 }]],
    },
    'Assess Polled Run': {
      main: [[{ node: 'Is Run Succeeded?', type: 'main', index: 0 }]],
    },
    'Get Run Output': {
      main: [[{ node: 'Assess Run Output', type: 'main', index: 0 }]],
    },
    'Assess Run Output': {
      main: [[{ node: 'Get Dataset Items', type: 'main', index: 0 }]],
    },
    'Get Dataset Items': {
      main: [[{ node: 'Normalize Jobs', type: 'main', index: 0 }]],
    },
    'Normalize Jobs': {
      main: [[{ node: 'Read Existing Jobs', type: 'main', index: 0 }]],
    },
    'Read Existing Jobs': {
      main: [[{ node: 'Filter New IDs', type: 'main', index: 0 }]],
    },
    'Filter New IDs': {
      main: [[{ node: 'Has New Jobs?', type: 'main', index: 0 }]],
    },
    'Has New Jobs?': {
      main: [
        [{ node: 'Split Out New Jobs', type: 'main', index: 0 }],
        [{ node: 'Run Summary', type: 'main', index: 0 }],
      ],
    },
    'Split Out New Jobs': {
      main: [[{ node: 'Append Rows', type: 'main', index: 0 }]],
    },
    'Append Rows': {
      main: [[{ node: 'Run Summary', type: 'main', index: 0 }]],
    },
  },
  active: false,
  settings: {
    executionOrder: 'v1',
    timezone: 'UTC',
  },
  meta: {
    templateCredsSetupCompleted: false,
  },
};

await writeFile(
  path.join(root, 'n8n', 'linkedin-jobs-to-google-sheets.json'),
  `${JSON.stringify(workflow, null, 2)}\n`,
);
