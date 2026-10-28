import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const root = path.resolve(here, '..');
export const sourceWorkflowPath = path.join(
  root,
  'n8n',
  'linkedin-jobs-to-google-sheets.json',
);
export const cloudWorkflowPath = path.join(
  root,
  'n8n',
  'linkedin-jobs-cloud.json',
);

export const cloudCodeFiles = {
  validateSettings: 'validate-cloud-settings.js',
  inputValidation: 'input-validation.js',
  assessDriveSearch: 'assess-drive-search.js',
  assessDriveCreate: 'assess-drive-create.js',
  assessSpreadsheetMetadata: 'assess-spreadsheet-metadata.js',
  assessAddedSheet: 'assess-added-sheet.js',
  assessJobsHeader: 'assess-jobs-header.js',
  assessEmptyWorksheet: 'assess-empty-worksheet.js',
  assessJobsHeaderWrite: 'assess-jobs-header-write.js',
  assessSetupReady: 'assess-setup-ready.js',
  assessRunSummary: 'assess-run-summary.js',
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

const codeNode = (id, name, position, jsCode) => node(
  id,
  name,
  'code',
  2,
  position,
  {
    mode: 'runOnceForAllItems',
    jsCode,
  },
);

const ifNode = (id, name, expression, position) => node(
  id,
  name,
  'if',
  2.2,
  position,
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [{
        id: `${id}-condition`,
        leftValue: `={{ ${expression} }}`,
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
  },
);

const googleHttpNode = (
  id,
  name,
  method,
  url,
  position,
  parameters = {},
  extra = {},
) => node(
  id,
  name,
  'httpRequest',
  4.2,
  position,
  {
    method,
    url,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'googleSheetsOAuth2Api',
    ...parameters,
    options: {
      response: {
        response: {
          fullResponse: true,
          responseFormat: 'json',
        },
      },
      timeout: 30000,
    },
  },
  {
    retryOnFail: false,
    onError: 'continueRegularOutput',
    alwaysOutputData: true,
    ...extra,
  },
);

const cloudStickyContent = `## Cloud quick setup

This variant uses OAuth credentials and creates its own Google spreadsheet. You do not copy a spreadsheet ID or header.

1. Connect an **Apify OAuth2** credential. In the credential's **Connection** settings, set **Allowed HTTP Request Domains** to **Specific Domains** and add \`api.apify.com\`; the default **None** blocks HTTP Request nodes, and **All** is unnecessary. Then select the credential on **Start Actor**, **Poll Actor Run**, **Get Run Output**, and **Get Dataset Items**. The current \`apifyOAuth2Api\` credential requests \`profile\` and \`full_api_access\`, which grants n8n full API access to the selected Apify account. The credential type is supplied by the official \`@apify/n8n-nodes-apify\` package; confirm that the package and credential are available in your n8n version. If you prefer a dedicated HTTP Header Auth token with narrower permissions, use the original HTTP Header Auth workflow as the optional fallback.
2. Connect one **Google Sheets OAuth2** credential. In the credential's **Connection** settings, set **Allowed HTTP Request Domains** to **Specific Domains** and enter \`www.googleapis.com,sheets.googleapis.com\` as the exact comma-separated hosts; the default **None** blocks HTTP Request nodes, and **All** is unnecessary. Then select the credential on every Google Drive, Google Sheets, **Read Existing Jobs**, and **Append Rows** node when n8n asks for one.
3. Save the workflow before the first run so \`$workflow.id\` is available. Open **Search settings** and set at least \`keywords\` and \`location\`.
4. Run the Manual Trigger and inspect the new spreadsheet and \`Jobs\` worksheet. The workflow creates the exact ten-column header when the worksheet is empty.

The workflow tags one spreadsheet with this workflow's ID. Later runs reuse that spreadsheet and never rewrite existing job rows. Keep one writer per workflow; concurrent first runs are not protected by a global lock. The schedule remains inactive until you enable it.`;

function addPrimarySettings(workflow) {
  const search = workflow.nodes.find(({ name }) => name === 'Search settings');
  if (!search) throw new Error('Search settings node was not found');

  search.parameters.assignments = {
    assignments: [
      {
        id: '44f182b9-78ab-46fe-96ac-f3ec0e794af3',
        name: 'keywords',
        value: 'software engineer',
        type: 'string',
      },
      {
        id: '0aa61d19-4101-4d2d-be3e-a9cf72ad005c',
        name: 'location',
        value: 'London, United Kingdom',
        type: 'string',
      },
      {
        id: 'c9941192-8e6b-4143-b606-cd78a9cf18fc',
        name: 'datePosted',
        value: 'pastWeek',
        type: 'string',
      },
      {
        id: '2df74e4c-6017-493e-9128-97aa54cd89cc',
        name: 'limit',
        value: 10,
        type: 'number',
      },
      {
        id: 'ad409653-f9ab-44db-b786-b0e0b55a21fb',
        name: 'budgetUsd',
        value: 1,
        type: 'number',
      },
      {
        id: '1f1514b8-7f0b-4f10-935c-66f5a7c21f69',
        name: 'scrapeCompany',
        value: false,
        type: 'boolean',
      },
      {
        id: 'bd34c0fa-a212-4e6b-aebd-ef41673f65ab',
        name: 'spreadsheetTitle',
        value: 'LinkedIn jobs',
        type: 'string',
      },
    ],
  };
}

function switchToApifyOAuth(workflow) {
  for (const name of [
    'Start Actor',
    'Poll Actor Run',
    'Get Run Output',
    'Get Dataset Items',
  ]) {
    const found = workflow.nodes.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Apify HTTP node ${name} was not found`);
    found.parameters.authentication = 'predefinedCredentialType';
    found.parameters.nodeCredentialType = 'apifyOAuth2Api';
    delete found.parameters.genericAuthType;
  }
}

function addCloudBootstrapNodes(workflow, code) {
  const nodes = [
    codeNode(
      'a1b3e0ac-4309-449f-b4fb-6cf5276fbd47',
      'Validate Cloud Settings',
      [-1740, -80],
      code.validateSettings,
    ),
    googleHttpNode(
      '14e12b03-cdc84c35-a737-12fb7cc7855a',
      'Find App Spreadsheet',
      'GET',
      'https://www.googleapis.com/drive/v3/files',
      [-1500, -80],
      {
        sendQuery: true,
        queryParameters: {
          parameters: [
            {
              name: 'q',
              value: "={{ \"trashed=false and mimeType='application/vnd.google-apps.spreadsheet' and appProperties has { key='mekaLinkedinJobsWorkflow' and value='\" + $json.workflowIdQuery + \"' }\" }}",
            },
            {
              name: 'fields',
              value: 'files(id,name,mimeType,appProperties),nextPageToken',
            },
            {
              name: 'pageSize',
              value: '2',
            },
          ],
        },
      },
    ),
    codeNode(
      'fa428ec8-2634-4452-bc80-92250662844a',
      'Assess Drive Search',
      [-1260, -80],
      code.assessDriveSearch,
    ),
    ifNode(
      '4f7ea8a7-01da-45fe-b774-f72a6c4533b6',
      'Existing App Spreadsheet?',
      "$json.nextAction === 'reuse'",
      [-1020, -80],
    ),
    googleHttpNode(
      'c359df92-0dc8-4652-af48-aa6b1170e82d',
      'Get Spreadsheet Metadata',
      'GET',
      "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($json.spreadsheetId) }}",
      [-780, -80],
      {
        sendQuery: true,
        queryParameters: {
          parameters: [
            {
              name: 'includeGridData',
              value: 'false',
            },
            {
              name: 'fields',
              value: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
            },
          ],
        },
      },
    ),
    googleHttpNode(
      '88667efe-0a6d-4d3f-baa2-0d91a78f2db1',
      'Create App Spreadsheet',
      'POST',
      'https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,appProperties',
      [-780, 120],
      {
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody: '={{ { "name": $json.spreadsheetTitle, "mimeType": "application/vnd.google-apps.spreadsheet", "appProperties": { "mekaLinkedinJobsWorkflow": $json.workflowId, "mekaLinkedinJobsBootstrapState": "pending", "mekaLinkedinJobsSchemaVersion": "1" } } }}',
      },
    ),
    codeNode(
      '52c8a79e-af09-4612-864f-7605bb0b0a1f',
      'Assess Created Spreadsheet',
      [-540, 120],
      code.assessDriveCreate,
    ),
    codeNode(
      'adfb9d15-82af-4800-94c7-5bf980f08337',
      'Assess Sheet Structure',
      [-300, -80],
      code.assessSpreadsheetMetadata,
    ),
    ifNode(
      '7f366816-7654-4c72-9ce7-2071095b231d',
      'Has Jobs Worksheet?',
      "$json.nextAction === 'check-header'",
      [-60, -80],
    ),
    googleHttpNode(
      '5f59decf-a542-4f36-ae3b-8514aa148a6a',
      'Add Jobs Worksheet',
      'POST',
      "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($json.spreadsheetId) + ':batchUpdate' }}",
      [180, 120],
      {
        sendQuery: true,
        queryParameters: {
          parameters: [{
            name: 'fields',
            value: 'replies(addSheet(properties(sheetId,title,gridProperties(rowCount,columnCount))))',
          }],
        },
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody: '={{ { "requests": [{ "addSheet": { "properties": { "title": "Jobs", "sheetId": 1731133718, "gridProperties": { "rowCount": 1000, "columnCount": 26 } } } }] } }}',
      },
    ),
    codeNode(
      '16c713f3-8fc4-4bea-929f-392fa6a588f0',
      'Assess Added Sheet',
      [420, 120],
      code.assessAddedSheet,
    ),
    googleHttpNode(
      '85da0fae-ee84-45f7-933f-eb7a1bc4476f',
      'Get Jobs Header',
      'GET',
      "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($json.spreadsheetId) + '/values/Jobs!A1%3AJ1' }}",
      [660, -80],
      {
        sendQuery: true,
        queryParameters: {
          parameters: [
            {
              name: 'majorDimension',
              value: 'ROWS',
            },
            {
              name: 'valueRenderOption',
              value: 'FORMATTED_VALUE',
            },
          ],
        },
      },
    ),
    codeNode(
      '3f097a1a-f371-4638-b7d1-29c331c63a61',
      'Assess Jobs Header',
      [900, -80],
      code.assessJobsHeader,
    ),
    ifNode(
      '3f7aaa76-e8e1-4d91-9e0b-7789370f0760',
      'Empty Header Found?',
      "$json.nextAction === 'inspect-empty'",
      [1140, -80],
    ),
    googleHttpNode(
      '2f8dc2cc-96b2-4b91-8ce4-87ce3ccb64e6',
      'Confirm Jobs Worksheet Empty',
      'GET',
      "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($json.spreadsheetId) + '/values/' + encodeURIComponent($json.emptyCheckRange) }}",
      [1380, 120],
      {
        sendQuery: true,
        queryParameters: {
          parameters: [
            {
              name: 'majorDimension',
              value: 'ROWS',
            },
            {
              name: 'valueRenderOption',
              value: 'FORMATTED_VALUE',
            },
          ],
        },
      },
    ),
    codeNode(
      'ab589333-8122-48d3-a500-3362d3e68fa1',
      'Assess Empty Worksheet',
      [1620, 120],
      code.assessEmptyWorksheet,
    ),
    googleHttpNode(
      'c94a80a6-c67e-4b56-b6fe-59c4222f38fa',
      'Write Jobs Header',
      'PUT',
      "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($json.spreadsheetId) + '/values/Jobs!A1%3AJ1' }}",
      [1860, 120],
      {
        sendQuery: true,
        queryParameters: {
          parameters: [
            {
              name: 'valueInputOption',
              value: 'RAW',
            },
            {
              name: 'includeValuesInResponse',
              value: 'true',
            },
          ],
        },
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody: '={{ { "range": "Jobs!A1:J1", "majorDimension": "ROWS", "values": [["id", "title", "company", "location", "postedAt", "url", "salary", "employmentType", "seniority", "firstSeenAt"]] } }}',
      },
    ),
    codeNode(
      'c22db842-2b6b-48bc-90a9-45bb183f4176',
      'Assess Header Write',
      [2100, 120],
      code.assessJobsHeaderWrite,
    ),
    googleHttpNode(
      '7fb0e4fe-2338-4446-97ae-e78471f85a31',
      'Mark Spreadsheet Ready',
      'PATCH',
      "={{ 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent($json.spreadsheetId) + '?fields=id,appProperties' }}",
      [2340, -80],
      {
        sendBody: true,
        contentType: 'json',
        specifyBody: 'json',
        jsonBody: '={{ { "appProperties": { "mekaLinkedinJobsWorkflow": $json.workflowId, "mekaLinkedinJobsBootstrapState": "ready", "mekaLinkedinJobsSchemaVersion": "1" } } }}',
      },
    ),
    codeNode(
      'fe0c61ce-7777-4811-9661-d3ad2ed66e58',
      'Assess Setup Ready',
      [2580, -80],
      code.assessSetupReady,
    ),
  ];
  return nodes;
}

function moveCoreNodes(workflow) {
  const positions = {
    'Input Validation': [2820, -80],
    'Start Actor': [3060, -80],
    'Assess Start Run': [3300, -80],
    'Is Run Succeeded?': [3540, -80],
    'Get Run Output': [3780, -200],
    'Assess Run Output': [4020, -200],
    'Get Dataset Items': [4260, -200],
    'Normalize Jobs': [4500, -200],
    'Read Existing Jobs': [4740, -200],
    'Filter New IDs': [4980, -200],
    'Has New Jobs?': [5220, -200],
    'Split Out New Jobs': [5460, -300],
    'Append Rows': [5700, -300],
    'Read Written Jobs': [5940, -360],
    'Run Summary': [6180, -200],
    'Wait for Actor': [3780, 120],
    'Poll Actor Run': [4020, 120],
    'Assess Polled Run': [4260, 120],
  };
  for (const found of workflow.nodes) {
    if (positions[found.name]) found.position = positions[found.name];
  }
}

function addConnections(workflow) {
  const main = (nodeName) => [[{ node: nodeName, type: 'main', index: 0 }]];
  Object.assign(workflow.connections, {
    'Manual Trigger': { main: main('Search settings') },
    'Daily Schedule': { main: main('Search settings') },
    'Search settings': { main: main('Validate Cloud Settings') },
    'Validate Cloud Settings': { main: main('Find App Spreadsheet') },
    'Find App Spreadsheet': { main: main('Assess Drive Search') },
    'Assess Drive Search': { main: main('Existing App Spreadsheet?') },
    'Existing App Spreadsheet?': {
      main: [
        [{ node: 'Get Spreadsheet Metadata', type: 'main', index: 0 }],
        [{ node: 'Create App Spreadsheet', type: 'main', index: 0 }],
      ],
    },
    'Create App Spreadsheet': { main: main('Assess Created Spreadsheet') },
    'Assess Created Spreadsheet': { main: main('Get Spreadsheet Metadata') },
    'Get Spreadsheet Metadata': { main: main('Assess Sheet Structure') },
    'Assess Sheet Structure': { main: main('Has Jobs Worksheet?') },
    'Has Jobs Worksheet?': {
      main: [
        [{ node: 'Get Jobs Header', type: 'main', index: 0 }],
        [{ node: 'Add Jobs Worksheet', type: 'main', index: 0 }],
      ],
    },
    'Add Jobs Worksheet': { main: main('Assess Added Sheet') },
    'Assess Added Sheet': { main: main('Get Jobs Header') },
    'Get Jobs Header': { main: main('Assess Jobs Header') },
    'Assess Jobs Header': { main: main('Empty Header Found?') },
    'Empty Header Found?': {
      main: [
        [{ node: 'Confirm Jobs Worksheet Empty', type: 'main', index: 0 }],
        [{ node: 'Mark Spreadsheet Ready', type: 'main', index: 0 }],
      ],
    },
    'Confirm Jobs Worksheet Empty': { main: main('Assess Empty Worksheet') },
    'Assess Empty Worksheet': { main: main('Write Jobs Header') },
    'Write Jobs Header': { main: main('Assess Header Write') },
    'Assess Header Write': { main: main('Mark Spreadsheet Ready') },
    'Mark Spreadsheet Ready': { main: main('Assess Setup Ready') },
    'Assess Setup Ready': { main: main('Input Validation') },
    'Has New Jobs?': {
      main: [
        [{ node: 'Split Out New Jobs', type: 'main', index: 0 }],
        [{ node: 'Read Written Jobs', type: 'main', index: 0 }],
      ],
    },
    'Append Rows': { main: main('Read Written Jobs') },
    'Read Written Jobs': { main: main('Run Summary') },
  });
}

export function buildCloudWorkflow(source, code) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Workflow source must be a JSON object');
  }
  if (!Array.isArray(source.nodes)) {
    throw new Error('Workflow source must contain a nodes array');
  }
  for (const [key, filename] of Object.entries(cloudCodeFiles)) {
    if (typeof code?.[key] !== 'string' || !code[key].trim()) {
      throw new Error(`Cloud Code source ${filename} is missing`);
    }
  }

  const workflow = structuredClone(source);
  workflow.name = 'LinkedIn jobs to Google Sheets (Cloud auto-setup)';
  workflow.active = false;
  workflow.settings = {
    ...workflow.settings,
    executionOrder: 'v1',
    timezone: 'UTC',
  };
  workflow.meta = {
    ...workflow.meta,
    templateCredsSetupCompleted: false,
  };

  addPrimarySettings(workflow);
  switchToApifyOAuth(workflow);

  const sticky = workflow.nodes.find(({ name }) => name === 'Before Running');
  if (!sticky) throw new Error('Before Running sticky note was not found');
  sticky.parameters.content = cloudStickyContent;
  sticky.parameters.width = 980;
  sticky.parameters.height = 520;
  sticky.position = [-2200, -720];

  for (const found of workflow.nodes) {
    if (found.name === 'Manual Trigger') found.position = [-2200, -180];
    if (found.name === 'Daily Schedule') found.position = [-2200, 20];
    if (found.name === 'Search settings') found.position = [-1980, -80];
  }

  const leadingNodes = workflow.nodes.filter(
    ({ name }) => ['Manual Trigger', 'Daily Schedule', 'Before Running', 'Search settings'].includes(name),
  );
  const preservedCoreNodes = workflow.nodes.filter(
    ({ name }) => !['Manual Trigger', 'Daily Schedule', 'Before Running', 'Search settings'].includes(name),
  );
  workflow.nodes = [
    ...leadingNodes,
    ...addCloudBootstrapNodes(workflow, code),
    ...preservedCoreNodes,
  ];

  const runSummary = workflow.nodes.find(({ name }) => name === 'Run Summary');
  if (!runSummary) throw new Error('Run Summary node was not found');
  runSummary.parameters.jsCode = code.assessRunSummary;

  const inputValidation = workflow.nodes.find(
    ({ name }) => name === 'Input Validation',
  );
  if (!inputValidation) throw new Error('Input Validation node was not found');
  inputValidation.parameters.jsCode = code.inputValidation;

  workflow.nodes.push(
    googleHttpNode(
      '42b7767b-2dc4-40cc-82f2-2131cf57eb1d',
      'Read Written Jobs',
      'GET',
      "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($('Input Validation').first().json.sheetId) + '/values/Jobs!A%3AJ' }}",
      [5940, -360],
      {
        sendQuery: true,
        queryParameters: {
          parameters: [
            {
              name: 'majorDimension',
              value: 'ROWS',
            },
            {
              name: 'valueRenderOption',
              value: 'FORMATTED_VALUE',
            },
          ],
        },
      },
      { executeOnce: true },
    ),
  );

  moveCoreNodes(workflow);
  addConnections(workflow);
  return workflow;
}

export async function loadCloudCode() {
  const entries = await Promise.all(
    Object.entries(cloudCodeFiles).map(async ([key, filename]) => {
      const source = await readFile(
        path.join(root, 'n8n', 'cloud-code', filename),
        'utf8',
      ).then((text) => text.trim());
      return [key, `${source}\n`];
    }),
  );
  return Object.fromEntries(entries);
}

export async function buildCloudWorkflowFile() {
  const [sourceText, code] = await Promise.all([
    readFile(sourceWorkflowPath, 'utf8'),
    loadCloudCode(),
  ]);
  const workflow = buildCloudWorkflow(JSON.parse(sourceText), code);
  await writeFile(cloudWorkflowPath, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
  return workflow;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await buildCloudWorkflowFile();
  console.log(`Wrote ${path.relative(root, cloudWorkflowPath)}`);
}
