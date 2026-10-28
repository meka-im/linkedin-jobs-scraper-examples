import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  buildCloudWorkflow,
  cloudWorkflowPath,
  loadCloudCode,
  sourceWorkflowPath,
} from '../scripts/build-cloud-workflow.mjs';
import { nodeByName, root } from './helpers.mjs';

const apifyHttpNodes = [
  'Start Actor',
  'Poll Actor Run',
  'Get Run Output',
  'Get Dataset Items',
];
const googleHttpNodes = [
  'Find App Spreadsheet',
  'Get Spreadsheet Metadata',
  'Create App Spreadsheet',
  'Add Jobs Worksheet',
  'Get Jobs Header',
  'Confirm Jobs Worksheet Empty',
  'Write Jobs Header',
  'Mark Spreadsheet Ready',
  'Read Written Jobs',
];
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
const sheetsUpdateValuesResponse = {
  spreadsheetId: 'sheet_123',
  updatedRange: "'Jobs'!A1:J1",
  updatedRows: 1,
  updatedColumns: 10,
  updatedCells: 10,
  updatedData: {
    range: "'Jobs'!A1:J1",
    majorDimension: 'ROWS',
    values: [expectedHeader],
  },
};
const workflowId = 'workflow_123';

let source;
let code;
let workflow;
let serializedWorkflow;

test.before(async () => {
  const [sourceText, cloudText, cloudCode] = await Promise.all([
    readFile(sourceWorkflowPath, 'utf8'),
    readFile(cloudWorkflowPath, 'utf8'),
    loadCloudCode(),
  ]);
  source = JSON.parse(sourceText);
  code = cloudCode;
  workflow = buildCloudWorkflow(source, code);
  serializedWorkflow = `${JSON.stringify(workflow, null, 2)}\n`;
  assert.equal(serializedWorkflow, cloudText);
});

function executeCloudCode(jsCode, {
  input = [],
  named = {},
  id = workflowId,
  execution = { id: 'execution_123', mode: 'test' },
} = {}) {
  const toItems = (items) => items.map((json) => ({ json }));
  const inputItems = toItems(input);
  const context = {
    $workflow: id == null ? undefined : { id },
    $execution: execution,
    $input: {
      all: () => inputItems,
      first: () => inputItems[0],
      last: () => inputItems.at(-1),
    },
    $: (name) => {
      if (!Object.hasOwn(named, name)) {
        throw new Error(`Node was not executed: ${name}`);
      }
      const items = toItems(named[name]);
      return {
        all: () => items,
        first: () => items[0],
        last: () => items.at(-1),
      };
    },
  };
  const script = new vm.Script(`(async () => {\n${jsCode}\n})()`, {
    filename: 'cloud-code-node.js',
  });
  return script.runInNewContext(context).then((output) => (
    JSON.parse(JSON.stringify(output))
  ));
}

const codeNode = (name) => nodeByName(workflow, name).parameters.jsCode;

function response(statusCode, body) {
  return { statusCode, body };
}

const cloudSettingsInput = {
  keywords: 'software engineer',
  location: 'London, United Kingdom',
  datePosted: 'pastWeek',
  limit: 10,
  budgetUsd: 1,
  scrapeCompany: false,
  spreadsheetTitle: 'LinkedIn jobs',
};

async function validatedSettings(
  overrides = {},
  { mode = 'test' } = {},
) {
  const [output] = await executeCloudCode(codeNode('Validate Cloud Settings'), {
    input: [{ ...cloudSettingsInput, ...overrides }],
    execution: { id: 'execution_123', mode },
  });
  return output.json;
}

function searchFile({
  id = 'sheet_123',
  bootstrapState = 'ready',
  schemaVersion = '1',
} = {}) {
  return {
    id,
    name: 'LinkedIn jobs',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    appProperties: {
      mekaLinkedinJobsWorkflow: workflowId,
      mekaLinkedinJobsBootstrapState: bootstrapState,
      mekaLinkedinJobsSchemaVersion: schemaVersion,
    },
  };
}

function sheetStructure(overrides = {}) {
  return {
    ...settings(),
    spreadsheetId: 'sheet_123',
    fileId: 'sheet_123',
    bootstrapState: 'pending',
    emptyCheckRange: 'Jobs!A1:Z1000',
    ...overrides,
  };
}

function jobsSheetProperties(sheetId = 0) {
  return {
    sheetId,
    title: 'Jobs',
    gridProperties: {
      rowCount: 1000,
      columnCount: 26,
    },
  };
}

function settings() {
  return {
    keywords: 'software engineer',
    location: 'London, United Kingdom',
    datePosted: 'pastWeek',
    limit: 10,
    budgetUsd: 1,
    scrapeCompany: false,
    spreadsheetTitle: 'LinkedIn jobs',
    workflowId,
    workflowIdQuery: workflowId,
    sheetName: 'Jobs',
    schemaVersion: '1',
  };
}

test('cloud artifact is reproducible, leaves the legacy artifact byte-identical, and has unique nodes', async () => {
  const [sourceBytes, rebuilt] = await Promise.all([
    readFile(sourceWorkflowPath),
    Promise.resolve(buildCloudWorkflow(source, code)),
  ]);
  assert.equal(
    createHash('sha256').update(sourceBytes).digest('hex'),
    '8823e9720a601683197fff35a30586343f58632515e1854d7f13cd417f2299ac',
  );
  assert.equal(`${JSON.stringify(rebuilt, null, 2)}\n`, serializedWorkflow);
  assert.equal(workflow.active, false);
  assert.equal(Object.hasOwn(workflow, 'pinData'), false);
  assert.equal(new Set(workflow.nodes.map(({ id }) => id)).size, workflow.nodes.length);
  assert.equal(new Set(workflow.nodes.map(({ name }) => name)).size, workflow.nodes.length);
});

test('Cloud search settings expose only the intended fields with limit 10 and no sheet ID', () => {
  const search = nodeByName(workflow, 'Search settings');
  const assignments = Object.fromEntries(
    search.parameters.assignments.assignments.map(({ name, value }) => [name, value]),
  );
  assert.deepEqual(assignments, {
    keywords: 'software engineer',
    location: 'London, United Kingdom',
    datePosted: 'pastWeek',
    limit: 10,
    budgetUsd: 1,
    scrapeCompany: false,
    spreadsheetTitle: 'LinkedIn jobs',
  });
  assert.equal(Object.hasOwn(assignments, 'sheetId'), false);
  assert.equal(Object.hasOwn(assignments, 'sheetName'), false);
  assert.deepEqual(
    workflow.connections['Search settings'].main[0],
    [{ node: 'Validate Cloud Settings', type: 'main', index: 0 }],
  );
});

test('all original Actor HTTP behavior is preserved while only authentication changes', () => {
  for (const name of apifyHttpNodes) {
    const original = structuredClone(nodeByName(source, name));
    const cloud = structuredClone(nodeByName(workflow, name));
    assert.equal(cloud.parameters.authentication, 'predefinedCredentialType');
    assert.equal(cloud.parameters.nodeCredentialType, 'apifyOAuth2Api');
    assert.equal(Object.hasOwn(cloud.parameters, 'genericAuthType'), false);
    assert.equal(cloud.retryOnFail, false);
    assert.equal(Object.hasOwn(cloud, 'credentials'), false);

    delete original.parameters.authentication;
    delete original.parameters.genericAuthType;
    delete cloud.parameters.authentication;
    delete cloud.parameters.nodeCredentialType;
    assert.deepEqual(cloud.parameters, original.parameters);
  }

  assert.equal(
    nodeByName(workflow, 'Get Run Output').parameters.url,
    nodeByName(source, 'Get Run Output').parameters.url,
  );
  assert.equal(
    nodeByName(workflow, 'Is Run Succeeded?').parameters.conditions.conditions[0].leftValue,
    "={{ $json.nextAction === 'fetch' }}",
  );
});

test('all Google bootstrap HTTP nodes use the Sheets OAuth2 predefined credential and full responses', () => {
  for (const name of googleHttpNodes) {
    const found = nodeByName(workflow, name);
    assert.equal(found.type, 'n8n-nodes-base.httpRequest');
    assert.equal(found.parameters.authentication, 'predefinedCredentialType');
    assert.equal(found.parameters.nodeCredentialType, 'googleSheetsOAuth2Api');
    assert.equal(found.parameters.options.response.response.fullResponse, true);
    assert.equal(found.parameters.options.timeout, 30000);
    assert.equal(found.retryOnFail, false);
    assert.equal(found.onError, 'continueRegularOutput');
    assert.equal(found.alwaysOutputData, true);
    assert.equal(Object.hasOwn(found, 'credentials'), false);
  }

  for (const name of ['Read Existing Jobs', 'Append Rows']) {
    const found = nodeByName(workflow, name);
    assert.equal(found.type, 'n8n-nodes-base.googleSheets');
    assert.equal(found.parameters.documentId.value, "={{ $('Input Validation').first().json.sheetId }}");
    assert.equal(found.parameters.sheetName.value, "={{ $('Input Validation').first().json.sheetName }}");
    assert.equal(Object.hasOwn(found, 'credentials'), false);
  }
  const append = nodeByName(workflow, 'Append Rows');
  assert.equal(append.parameters.options.cellFormat, 'RAW');
  assert.equal(append.parameters.columns.schema.length, 10);
  assert.deepEqual(
    Object.keys(append.parameters.columns.value),
    expectedHeader,
  );
});

test('all legacy core nodes and core connections remain unchanged outside authentication', () => {
  const coreNames = new Set([
    'Input Validation',
    'Start Actor',
    'Assess Start Run',
    'Is Run Succeeded?',
    'Wait for Actor',
    'Poll Actor Run',
    'Assess Polled Run',
    'Get Run Output',
    'Assess Run Output',
    'Get Dataset Items',
    'Normalize Jobs',
    'Read Existing Jobs',
    'Filter New IDs',
    'Has New Jobs?',
    'Split Out New Jobs',
    'Append Rows',
    'Read Written Jobs',
    'Run Summary',
  ]);
  for (const name of coreNames) {
    if (name === 'Read Written Jobs') {
      const readback = nodeByName(workflow, name);
      assert.equal(readback.type, 'n8n-nodes-base.httpRequest');
      assert.equal(readback.typeVersion, 4.2);
      assert.equal(readback.executeOnce, true);
      assert.equal(
        readback.parameters.url,
        "={{ 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent($('Input Validation').first().json.sheetId) + '/values/Jobs!A%3AJ' }}",
      );
      continue;
    }
    const original = nodeByName(source, name);
    const cloud = nodeByName(workflow, name);
    assert.equal(cloud.type, original.type, name);
    assert.equal(cloud.typeVersion, original.typeVersion, name);
    if (
      apifyHttpNodes.includes(name)
      || name === 'Input Validation'
      || name === 'Run Summary'
      || name === 'Read Written Jobs'
    ) continue;
    assert.deepEqual(cloud.parameters, original.parameters, name);
  }
  for (const [name, connection] of Object.entries(source.connections)) {
    if (!coreNames.has(name)) continue;
    if (name === 'Has New Jobs?' || name === 'Append Rows') continue;
    assert.deepEqual(workflow.connections[name], connection, name);
  }
  assert.equal(
    nodeByName(workflow, 'Input Validation').parameters.jsCode,
    code.inputValidation,
  );
  assert.deepEqual(workflow.connections['Has New Jobs?'], {
    main: [
      [{ node: 'Split Out New Jobs', type: 'main', index: 0 }],
      [{ node: 'Read Written Jobs', type: 'main', index: 0 }],
    ],
  });
  assert.deepEqual(workflow.connections['Append Rows'], {
    main: [[{ node: 'Read Written Jobs', type: 'main', index: 0 }]],
  });
  assert.deepEqual(workflow.connections['Read Written Jobs'], {
    main: [[{ node: 'Run Summary', type: 'main', index: 0 }]],
  });
  assert.deepEqual(
    workflow.connections['Assess Setup Ready'].main[0],
    [{ node: 'Input Validation', type: 'main', index: 0 }],
  );
  assert.deepEqual(new Set(
    workflow.nodes
      .flatMap(({ name }) => {
        const connection = workflow.connections[name]?.main?.flat() ?? [];
        return connection
          .filter(({ node }) => node === 'Start Actor')
          .map(() => name);
      }),
  ), new Set(['Input Validation']));
});

test('cloud bootstrap validation rejects invalid settings and unsaved workflows before any request', async () => {
  await assert.rejects(
    executeCloudCode(codeNode('Validate Cloud Settings'), {
      id: null,
      input: [cloudSettingsInput],
    }),
    /Save this workflow.*\$workflow\.id/,
  );
  for (const invalid of [
    { keywords: ' ' },
    { location: '' },
    { datePosted: 'yesterday' },
    { limit: 1.5 },
    { budgetUsd: 0 },
    { scrapeCompany: 'false' },
    { spreadsheetTitle: 42 },
  ]) {
    await assert.rejects(
      executeCloudCode(codeNode('Validate Cloud Settings'), {
        input: [{ ...cloudSettingsInput, ...invalid }],
      }),
    );
  }
  const [output] = await executeCloudCode(codeNode('Validate Cloud Settings'), {
    input: [cloudSettingsInput],
  });
  assert.equal(output.json.sheetName, 'Jobs');
  assert.equal(output.json.workflowId, workflowId);
  assert.equal(Object.hasOwn(output.json, 'sheetId'), false);
  const [blankTitle] = await executeCloudCode(codeNode('Validate Cloud Settings'), {
    input: [{ ...cloudSettingsInput, spreadsheetTitle: '' }],
  });
  assert.equal(blankTitle.json.spreadsheetTitle, 'LinkedIn jobs');
});

test('manual test mode is clamped while production keeps the requested schedule budget', async () => {
  const requested = {
    limit: 1000,
    budgetUsd: 20,
    scrapeCompany: true,
  };
  const testSettings = await validatedSettings(requested, { mode: 'test' });
  assert.equal(testSettings.executionMode, 'test');
  assert.equal(testSettings.manualRun, true);
  assert.equal(testSettings.limit, 10);
  assert.equal(testSettings.budgetUsd, 1);
  assert.equal(testSettings.scrapeCompany, false);
  assert.equal(testSettings.requestedLimit, 1000);
  assert.equal(testSettings.requestedBudgetUsd, 20);
  assert.equal(testSettings.requestedScrapeCompany, true);

  const lowerBudgetSettings = await validatedSettings(
    { ...requested, budgetUsd: 0.25 },
    { mode: 'test' },
  );
  assert.equal(lowerBudgetSettings.budgetUsd, 0.25);

  const productionSettings = await validatedSettings(requested, {
    mode: 'production',
  });
  assert.equal(productionSettings.executionMode, 'production');
  assert.equal(productionSettings.manualRun, false);
  assert.equal(productionSettings.limit, 1000);
  assert.equal(productionSettings.budgetUsd, 20);
  assert.equal(productionSettings.scrapeCompany, true);

  for (const execution of [
    { id: 'execution_123' },
    { id: 'execution_123', mode: 'manual' },
    { id: 'execution_123', mode: 'unknown' },
  ]) {
    await assert.rejects(
      executeCloudCode(codeNode('Validate Cloud Settings'), {
        input: [cloudSettingsInput],
        execution,
      }),
      /\$execution\.mode must be either test or production/u,
    );
  }
});

test('Input Validation preserves the final manual-run guard for Run Summary', async () => {
  const testSettings = await validatedSettings(
    { limit: 1000, budgetUsd: 20, scrapeCompany: true },
    { mode: 'test' },
  );
  const [validated] = await executeCloudCode(codeNode('Input Validation'), {
    input: [{
      ...testSettings,
      sheetId: 'sheet_123',
      sheetName: 'Jobs',
    }],
    execution: { id: 'execution_123', mode: 'test' },
  });
  assert.equal(validated.json.executionMode, 'test');
  assert.equal(validated.json.manualRun, true);
  assert.equal(validated.json.limit, 10);
  assert.equal(validated.json.budgetUsd, 1);
  assert.equal(validated.json.scrapeCompany, false);
  assert.equal(validated.json.workflowId, workflowId);
  assert.equal(validated.json.sheetId, 'sheet_123');
  assert.equal(validated.json.count, 10);
  assert.equal(validated.json.limitPerSource, 10);

  await assert.rejects(
    executeCloudCode(codeNode('Input Validation'), {
      input: [{
        ...validated.json,
        budgetUsd: 1.01,
      }],
      execution: { id: 'execution_123', mode: 'test' },
    }),
    /10-job, \$1/u,
  );
  await assert.rejects(
    executeCloudCode(codeNode('Input Validation'), {
      input: [{
        ...validated.json,
        executionMode: 'unknown',
      }],
    }),
    /executionMode/u,
  );
});

test('Drive lookup chooses no file, one pending or ready file, and rejects ambiguous pages', async () => {
  const settings = await validatedSettings();
  const assessSearch = async (body) => {
    const [output] = await executeCloudCode(codeNode('Assess Drive Search'), {
      input: [response(200, body)],
      named: { 'Validate Cloud Settings': [settings] },
    });
    return output.json;
  };

  assert.equal((await assessSearch({ files: [] })).nextAction, 'create');
  const pending = await assessSearch({ files: [searchFile({ bootstrapState: 'pending' })] });
  assert.equal(pending.nextAction, 'reuse');
  assert.equal(pending.spreadsheetId, 'sheet_123');
  assert.equal(pending.bootstrapState, 'pending');
  const ready = await assessSearch({ files: [searchFile()] });
  assert.equal(ready.bootstrapState, 'ready');

  await assert.rejects(
    assessSearch({ files: [searchFile(), searchFile({ id: 'sheet_456' })] }),
    /Multiple app spreadsheets/,
  );
  await assert.rejects(
    assessSearch({ files: [searchFile()], nextPageToken: 'more' }),
    /another page/,
  );
  await assert.rejects(
    assessSearch({ files: [searchFile({ schemaVersion: '2' })] }),
    /schema version 2/,
  );
});

test('a created spreadsheet is pending and a lost create response recovers from the tagged file', async () => {
  const settings = await validatedSettings();
  const searchState = { ...settings, nextAction: 'create' };
  const [created] = await executeCloudCode(codeNode('Assess Created Spreadsheet'), {
    input: [response(200, {
      id: 'sheet_123',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      appProperties: {
        mekaLinkedinJobsWorkflow: workflowId,
        mekaLinkedinJobsBootstrapState: 'pending',
        mekaLinkedinJobsSchemaVersion: '1',
      },
    })],
    named: { 'Assess Drive Search': [searchState] },
  });
  assert.equal(created.json.spreadsheetId, 'sheet_123');
  assert.equal(created.json.bootstrapState, 'pending');
  assert.equal(created.json.created, true);

  await assert.rejects(
    executeCloudCode(codeNode('Assess Created Spreadsheet'), {
      input: [response(undefined, undefined)],
      named: { 'Assess Drive Search': [searchState] },
    }),
    /NO_STATUS/,
  );
  const [recovered] = await executeCloudCode(codeNode('Assess Drive Search'), {
    input: [response(200, { files: [searchFile({ bootstrapState: 'pending' })] })],
    named: { 'Validate Cloud Settings': [settings] },
  });
  assert.equal(recovered.json.spreadsheetId, 'sheet_123');
  assert.equal(recovered.json.bootstrapState, 'pending');
  assert.equal(recovered.json.created, false);
});

test('pending files add only the missing Jobs worksheet; ready files fail instead of being reset', async () => {
  const search = {
    ...settings(),
    spreadsheetId: 'sheet_123',
    fileId: 'sheet_123',
    bootstrapState: 'pending',
  };
  const assessMetadata = async (body, overrides = {}) => {
    const [output] = await executeCloudCode(codeNode('Assess Sheet Structure'), {
      input: [response(200, body)],
      named: {
        'Validate Cloud Settings': [settings()],
        'Assess Drive Search': [{ ...search, ...overrides }],
      },
    });
    return output.json;
  };

  const existing = await assessMetadata({
    sheets: [{ properties: jobsSheetProperties() }],
  });
  assert.equal(existing.nextAction, 'check-header');
  assert.equal(existing.sheetId, 0);
  assert.equal(existing.emptyCheckRange, 'Jobs!A1:Z1000');
  const missingPending = await assessMetadata({
    sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
  });
  assert.equal(missingPending.nextAction, 'add-sheet');

  await assert.rejects(
    assessMetadata(
      { sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] },
      { bootstrapState: 'ready' },
    ),
    /ready app spreadsheet is missing its Jobs worksheet/,
  );
  await assert.rejects(
    assessMetadata({
      sheets: [
        { properties: jobsSheetProperties(0) },
        { properties: jobsSheetProperties(1) },
      ],
    }),
    /multiple Jobs worksheets/,
  );

  const [createdPath] = await executeCloudCode(codeNode('Assess Sheet Structure'), {
    input: [response(200, {
      sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }],
    })],
    named: {
      'Validate Cloud Settings': [settings()],
      'Assess Drive Search': [{
        ...settings(),
        nextAction: 'create',
      }],
      'Assess Created Spreadsheet': [{
        ...settings(),
        spreadsheetId: 'new_sheet_123',
        fileId: 'new_sheet_123',
        bootstrapState: 'pending',
        created: true,
      }],
    },
  });
  assert.equal(createdPath.json.spreadsheetId, 'new_sheet_123');
  assert.equal(createdPath.json.nextAction, 'add-sheet');

  const addState = {
    ...settings(),
    spreadsheetId: 'sheet_123',
    bootstrapState: 'pending',
    nextAction: 'add-sheet',
  };
  const [added] = await executeCloudCode(codeNode('Assess Added Sheet'), {
    input: [response(200, {
      replies: [{
        addSheet: {
          properties: {
            sheetId: 1731133718,
            title: 'Jobs',
            gridProperties: {
              rowCount: 1000,
              columnCount: 26,
            },
          },
        },
      }],
    })],
    named: { 'Assess Sheet Structure': [addState] },
  });
  assert.equal(added.json.sheetId, 1731133718);
  assert.equal(added.json.emptyCheckRange, 'Jobs!A1:Z1000');
  assert.equal(added.json.nextAction, 'check-header');
  await assert.rejects(
    executeCloudCode(codeNode('Assess Added Sheet'), {
      input: [response(500, {})],
      named: { 'Assess Sheet Structure': [addState] },
    }),
    /HTTP 500/,
  );
});

test('daily header checks are bounded and pending empty confirmation protects non-header content', async () => {
  const structure = sheetStructure({ sheetId: 0, nextAction: 'check-header' });
  const assessHeader = async (body) => {
    const [output] = await executeCloudCode(codeNode('Assess Jobs Header'), {
      input: [response(200, body)],
      named: { 'Assess Sheet Structure': [structure] },
    });
    return output.json;
  };

  assert.equal((await assessHeader({})).nextAction, 'inspect-empty');
  assert.equal((await assessHeader({ values: [[]] })).nextAction, 'inspect-empty');
  assert.equal((await assessHeader({ values: [expectedHeader] })).nextAction, 'continue');

  await assert.rejects(
    assessHeader({
      values: [
        [...expectedHeader, 'unexpectedExtraColumn'],
      ],
    }),
    /refusing to overwrite/,
  );
  await assert.rejects(
    assessHeader({
      values: [['id', 'wrong-header']],
    }),
    /refusing to overwrite/,
  );
  const readyStructure = sheetStructure({
    bootstrapState: 'ready',
    sheetId: 0,
    nextAction: 'check-header',
  });
  await assert.rejects(
    executeCloudCode(codeNode('Assess Jobs Header'), {
      input: [response(200, {
        values: [['id', 'wrong-header']],
      })],
      named: { 'Assess Sheet Structure': [readyStructure] },
    }),
    /ready app spreadsheet.*refusing to reset/,
  );
  await assert.rejects(
    executeCloudCode(codeNode('Assess Jobs Header'), {
      input: [response(200, {})],
      named: { 'Assess Sheet Structure': [readyStructure] },
    }),
    /ready app spreadsheet.*refusing to reset/,
  );

  const emptyState = {
    ...structure,
    nextAction: 'inspect-empty',
  };
  const assessEmpty = async (body, state = emptyState) => {
    const [output] = await executeCloudCode(codeNode('Assess Empty Worksheet'), {
      input: [response(200, body)],
      named: { 'Assess Jobs Header': [state] },
    });
    return output.json;
  };
  assert.equal((await assessEmpty({})).nextAction, 'write-header');
  assert.equal((await assessEmpty({ values: [] })).nextAction, 'write-header');
  await assert.rejects(
    assessEmpty({
      values: [
        [],
        ['', 'Unexpected row without a header'],
      ],
    }),
    /refusing to overwrite/,
  );
  await assert.rejects(
    assessEmpty(
      { values: [] },
      { ...emptyState, bootstrapState: 'ready' },
    ),
    /only while bootstrap is pending/,
  );
  await assert.rejects(
    executeCloudCode(codeNode('Assess Empty Worksheet'), {
      input: [response(500, {})],
      named: { 'Assess Jobs Header': [emptyState] },
    }),
    /HTTP 500/,
  );

  const retryHeader = nodeByName(workflow, 'Get Jobs Header');
  const emptyConfirmation = nodeByName(workflow, 'Confirm Jobs Worksheet Empty');
  assert.match(retryHeader.parameters.url, /Jobs!A1%3AJ1/);
  assert.doesNotMatch(retryHeader.parameters.url, /A%3AZZZ|A%3AZ/);
  assert.match(emptyConfirmation.parameters.url, /emptyCheckRange/);
  assert.deepEqual(
    workflow.connections['Empty Header Found?'].main,
    [
      [{ node: 'Confirm Jobs Worksheet Empty', type: 'main', index: 0 }],
      [{ node: 'Mark Spreadsheet Ready', type: 'main', index: 0 }],
    ],
  );

  const write = nodeByName(workflow, 'Write Jobs Header');
  assert.equal(write.parameters.method, 'PUT');
  assert.equal(write.parameters.queryParameters.parameters[0].value, 'RAW');
  assert.match(write.parameters.url, /Jobs!A1%3AJ1/);
});

test('header write and ready marker preserve the resolved spreadsheet for the original validator', async () => {
  const structure = sheetStructure({ sheetId: 0, nextAction: 'check-header' });
  const added = { ...structure, sheetId: 1731133718 };
  const [written] = await executeCloudCode(codeNode('Assess Header Write'), {
    input: [response(200, sheetsUpdateValuesResponse)],
    named: {
      'Assess Sheet Structure': [structure],
      'Assess Added Sheet': [added],
    },
  });
  assert.equal(written.json.sheetId, 1731133718);
  assert.equal(written.json.nextAction, 'mark-ready');

  for (const invalidResponse of [
    { ...sheetsUpdateValuesResponse, spreadsheetId: 'different_sheet' },
    { ...sheetsUpdateValuesResponse, updatedRange: "'Jobs'!A1:J2" },
    {
      ...sheetsUpdateValuesResponse,
      updatedData: {
        ...sheetsUpdateValuesResponse.updatedData,
        range: "'Jobs'!A1:J2",
      },
    },
    { ...sheetsUpdateValuesResponse, updatedRows: 0 },
    { ...sheetsUpdateValuesResponse, updatedColumns: 9 },
    { ...sheetsUpdateValuesResponse, updatedCells: 9 },
    { ...sheetsUpdateValuesResponse, updatedData: undefined },
    {
      ...sheetsUpdateValuesResponse,
      updatedData: {
        ...sheetsUpdateValuesResponse.updatedData,
        values: [['id', 'wrong-header']],
      },
    },
  ]) {
    await assert.rejects(
      executeCloudCode(codeNode('Assess Header Write'), {
        input: [response(200, invalidResponse)],
        named: {
          'Assess Sheet Structure': [structure],
          'Assess Added Sheet': [added],
        },
      }),
      /header write/,
    );
  }
  await assert.rejects(
    executeCloudCode(codeNode('Assess Header Write'), {
      input: [response(500, sheetsUpdateValuesResponse)],
      named: {
        'Assess Sheet Structure': [structure],
        'Assess Added Sheet': [added],
      },
    }),
    /HTTP 500/,
  );

  const [ready] = await executeCloudCode(codeNode('Assess Setup Ready'), {
    input: [response(200, {
      id: 'sheet_123',
      appProperties: {
        mekaLinkedinJobsWorkflow: workflowId,
        mekaLinkedinJobsBootstrapState: 'ready',
        mekaLinkedinJobsSchemaVersion: '1',
      },
    })],
    named: {
      'Assess Sheet Structure': [structure],
      'Assess Added Sheet': [added],
    },
  });
  assert.deepEqual(ready.json, {
    ...structure,
    ...added,
    sheetId: 'sheet_123',
    sheetName: 'Jobs',
    spreadsheetTitle: cloudSettingsInput.spreadsheetTitle,
    workflowId,
    bootstrapState: 'ready',
  });

  await assert.rejects(
    executeCloudCode(codeNode('Assess Setup Ready'), {
      input: [response(200, {
        id: 'sheet_123',
        appProperties: {
          mekaLinkedinJobsWorkflow: workflowId,
          mekaLinkedinJobsBootstrapState: 'pending',
          mekaLinkedinJobsSchemaVersion: '1',
        },
      })],
      named: { 'Assess Sheet Structure': [structure] },
    }),
    /did not persist ready state/,
  );
});

test('HTTP status failures stop before the paid core chain across the bootstrap', async () => {
  const settings = await validatedSettings();
  for (const statusCode of [undefined, 199, 300, 400, 500]) {
    await assert.rejects(
      executeCloudCode(codeNode('Assess Drive Search'), {
        input: [response(statusCode, { files: [] })],
        named: { 'Validate Cloud Settings': [settings] },
      }),
      /HTTP/,
    );
  }

  const bootstrapNodes = new Set([
    'Validate Cloud Settings',
    'Find App Spreadsheet',
    'Assess Drive Search',
    'Existing App Spreadsheet?',
    'Get Spreadsheet Metadata',
    'Create App Spreadsheet',
    'Assess Created Spreadsheet',
    'Assess Sheet Structure',
    'Has Jobs Worksheet?',
    'Add Jobs Worksheet',
    'Assess Added Sheet',
    'Get Jobs Header',
    'Assess Jobs Header',
    'Empty Header Found?',
    'Confirm Jobs Worksheet Empty',
    'Assess Empty Worksheet',
    'Write Jobs Header',
    'Assess Header Write',
    'Mark Spreadsheet Ready',
    'Assess Setup Ready',
  ]);
  for (const name of bootstrapNodes) {
    if (name === 'Assess Setup Ready') continue;
    const outgoing = workflow.connections[name]?.main?.flat() ?? [];
    assert.equal(
      outgoing.some(({ node }) => ['Start Actor', 'Input Validation'].includes(node)),
      false,
      `${name} bypasses bootstrap completion`,
    );
  }
});

test('manual Run Summary requires independent sheet readback and rejects incomplete evidence', async () => {
  const config = await validatedSettings(
    { limit: 1000, budgetUsd: 20, scrapeCompany: true },
    { mode: 'test' },
  );
  const priorRows = [{
    id: '100',
    title: 'Existing role',
    company: 'Existing Co',
    location: 'London',
    postedAt: '2026-10-26',
    url: 'https://www.linkedin.com/jobs/view/100',
    salary: '',
    employmentType: 'FULL_TIME',
    seniority: 'SENIOR',
    firstSeenAt: '2026-10-26T10:00:00.000Z',
  }];
  const newJobs = [
    {
      id: '101',
      title: 'Backend engineer',
      company: 'Readback Co',
      location: 'Remote',
      postedAt: '2026-10-27',
      url: 'https://www.linkedin.com/jobs/view/101',
      salary: '$100k',
      employmentType: 'FULL_TIME',
      seniority: 'MID',
      firstSeenAt: '2026-10-27T10:00:00.000Z',
    },
    {
      id: '102',
      title: 'Platform engineer',
      company: 'Readback Co',
      location: 'London',
      postedAt: '2026-10-27',
      url: 'https://www.linkedin.com/jobs/view/102',
      salary: '',
      employmentType: 'CONTRACT',
      seniority: 'SENIOR',
      firstSeenAt: '2026-10-27T10:00:00.000Z',
    },
  ];
  const row = (job) => expectedHeader.map((field) => String(job[field] ?? ''));
  const summary = {
    fetchedCount: 4,
    newCount: 2,
    skippedExisting: 1,
    skippedBatchDuplicates: 1,
    coverage: 'complete',
    actorSummary: {
      failedSearches: 0,
      failedJobDetails: 0,
      failedCompanies: 0,
      stoppedByBudget: false,
    },
  };
  const assess = async ({
    responseValue = response(200, {
      values: [expectedHeader, row(priorRows[0]), ...newJobs.map(row)],
    }),
    filtered = { summary, newJobs },
    configValue = config,
    prior = priorRows,
  } = {}) => {
    const [output] = await executeCloudCode(codeNode('Run Summary'), {
      input: [responseValue],
      named: {
        'Filter New IDs': [filtered],
        'Input Validation': [configValue],
        'Read Existing Jobs': prior,
      },
    });
    return output.json;
  };

  const passed = await assess();
  assert.equal(passed.status, 'passed');
  assert.equal(passed.testPassed, true);
  assert.equal(passed.readbackVerified, true);
  assert.equal(passed.appendedCount, 2);
  assert.equal(passed.previousRowsUnchanged, true);
  assert.equal(passed.allFieldsPresent, true);
  assert.equal(passed.firstSeenAtPresent, true);
  assert.equal(passed.uniqueIds, true);
  assert.equal(passed.executionMode, 'test');
  assert.equal(passed.manualLimit, 10);
  assert.equal(passed.manualBudgetUsd, 1);

  const wrongTitleRows = [
    expectedHeader,
    row(priorRows[0]),
    row({ ...newJobs[0], title: 'Different title' }),
    row(newJobs[1]),
  ];
  const wrongTitle = await assess({
    responseValue: response(200, { values: wrongTitleRows }),
  });
  assert.equal(wrongTitle.status, 'write-unverified');
  assert.equal(wrongTitle.testPassed, false);
  assert.equal(wrongTitle.readbackVerified, false);

  const missingFirstSeenRows = structuredClone(wrongTitleRows);
  missingFirstSeenRows[2][9] = '';
  const missingFirstSeen = await assess({
    responseValue: response(200, { values: missingFirstSeenRows }),
  });
  assert.equal(missingFirstSeen.status, 'write-unverified');
  assert.equal(missingFirstSeen.firstSeenAtPresent, false);

  const changedPriorRows = structuredClone(wrongTitleRows);
  changedPriorRows[1][1] = 'Changed existing role';
  const changedPrior = await assess({
    responseValue: response(200, { values: changedPriorRows }),
  });
  assert.equal(changedPrior.status, 'write-unverified');
  assert.equal(changedPrior.previousRowsUnchanged, false);
  assert.equal(changedPrior.failureCategory, 'sheet-readback-changed-prior-rows');

  const forbidden = await assess({
    responseValue: response(403, { error: 'secret upstream body' }),
  });
  assert.equal(forbidden.status, 'write-unverified');
  assert.equal(forbidden.failureCategory, 'sheet-read-failed');
  assert.equal(JSON.stringify(forbidden).includes('secret upstream body'), false);

  const missingCounter = await assess({
    filtered: {
      newJobs,
      summary: {
        ...summary,
        actorSummary: {
          failedSearches: 0,
          failedJobDetails: 0,
          stoppedByBudget: false,
        },
      },
    },
  });
  assert.equal(missingCounter.status, 'invalid-summary');
  assert.equal(missingCounter.testPassed, false);

  const missingCoverage = await assess({
    filtered: {
      summary: {
        ...summary,
        coverage: undefined,
      },
      newJobs,
    },
  });
  assert.equal(missingCoverage.status, 'invalid-summary');

  const partial = await assess({
    filtered: {
      summary: {
        ...summary,
        coverage: 'partial',
        actorSummary: {
          ...summary.actorSummary,
          stoppedByBudget: true,
        },
      },
      newJobs,
    },
  });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.testPassed, false);
  assert.equal(partial.failureCategory, 'budget-stopped');

  const noNewRows = await assess({
    responseValue: response(200, {
      values: [expectedHeader, row(priorRows[0])],
    }),
    filtered: {
      summary: {
        ...summary,
        fetchedCount: 1,
        newCount: 0,
        skippedExisting: 1,
        skippedBatchDuplicates: 0,
      },
      newJobs: [],
    },
  });
  assert.equal(noNewRows.status, 'no-new-rows');
  assert.equal(noNewRows.testPassed, false);
  assert.equal(noNewRows.readbackVerified, false);
});

test('the OAuth smoke fixture is read-only, credential-free, and suitable for live UI compatibility checks', async () => {
  const fixturePath = path.join(root, 'tests', 'fixtures', 'cloud-auth-smoke.workflow.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  assert.equal(fixture.name, 'MEKA Cloud OAuth connection check');
  assert.equal(fixture.active, false);
  assert.equal(Object.hasOwn(fixture, 'pinData'), false);
  const apify = nodeByName(fixture, 'Check Apify OAuth');
  assert.equal(apify.parameters.method, 'GET');
  assert.equal(apify.parameters.url, 'https://api.apify.com/v2/users/me');
  assert.equal(apify.parameters.authentication, 'predefinedCredentialType');
  assert.equal(apify.parameters.nodeCredentialType, 'apifyOAuth2Api');
  assert.equal(apify.parameters.options.timeout, 30000);
  assert.equal(Object.hasOwn(apify.parameters, 'sendBody'), false);

  const google = nodeByName(fixture, 'Check Google OAuth');
  assert.equal(google.parameters.method, 'GET');
  assert.equal(google.parameters.url, 'https://www.googleapis.com/drive/v3/files');
  assert.equal(google.parameters.authentication, 'predefinedCredentialType');
  assert.equal(google.parameters.nodeCredentialType, 'googleSheetsOAuth2Api');
  assert.equal(google.parameters.options.timeout, 30000);
  assert.equal(google.parameters.queryParameters.parameters[2].value, '1');
  assert.match(google.parameters.queryParameters.parameters[0].value, /never-created/);
  assert.equal(google.parameters.queryParameters.parameters[1].value, 'files(id),nextPageToken');
  const serialized = JSON.stringify(fixture);
  assert.doesNotMatch(serialized, /"credentials"\s*:/);
  assert.doesNotMatch(serialized, /Bearer\s+/);
  assert.doesNotMatch(serialized, /spreadsheetId/i);
  assert.doesNotMatch(serialized, /meka\.im|@/i);
});

test('cloud artifact contains no credential objects, tokens, private spreadsheet IDs, or pin data', () => {
  for (const found of workflow.nodes) {
    assert.equal(Object.hasOwn(found, 'credentials'), false, `${found.name} embeds credentials`);
  }
  assert.doesNotMatch(serializedWorkflow, /Bearer\s+(?!<)[A-Za-z0-9._~-]{8,}/);
  assert.doesNotMatch(serializedWorkflow, /apify_api_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(serializedWorkflow, /"spreadsheetId"\s*:/);
  assert.doesNotMatch(serializedWorkflow, /"pinData"\s*:/);
});

test('historical Cloud acceptance evidence remains tied to its original artifact', async () => {
  const cloudText = await readFile(cloudWorkflowPath);
  const currentSha256 = createHash('sha256').update(cloudText).digest('hex');
  const evidencePath = path.join(
    root,
    'validation',
    '2026-10-25',
    'cloud-auto-setup-acceptance.json',
  );
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));

  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.measurement, 'cloud-auto-setup-acceptance');
  assert.equal(
    evidence.artifacts.cloudWorkflow.sha256,
    'fcdb945365562ec97243d353b344ecc67b1a9738c310d15cfe18f130122dd85b',
  );
  assert.notEqual(currentSha256, evidence.artifacts.cloudWorkflow.sha256);
  assert.equal(evidence.runtime.version, '2.45.3');
  assert.equal(evidence.runtime.environment, 'Experimental');
  assert.equal(evidence.runtime.apifyCommunityNodeVerified, true);
  assert.equal(evidence.credentialBinding.credentialBearingNodes, 14);
  assert.equal(evidence.credentialBinding.preflight.httpStatus, 'NO_STATUS');
  assert.equal(evidence.credentialBinding.preflight.actorRunsStarted, 0);
  assert.deepEqual(
    evidence.runs.map(({ fetchedCount, newCount, appendedCount, skippedExisting }) => ({
      fetchedCount,
      newCount,
      appendedCount,
      skippedExisting,
    })),
    [
      {
        fetchedCount: 10,
        newCount: 10,
        appendedCount: 10,
        skippedExisting: 0,
      },
      {
        fetchedCount: 10,
        newCount: 0,
        appendedCount: 0,
        skippedExisting: 10,
      },
    ],
  );
  assert.equal(evidence.spreadsheet.sameSpreadsheetReused, true);
  assert.equal(evidence.spreadsheet.bootstrapState, 'ready');
  assert.equal(evidence.spreadsheet.run1BusinessFieldsPreserved, 100);
  assert.equal(evidence.execution.importedTimezonePreserved, false);
  assert.equal(evidence.execution.manualRunsTimezone, 'instance-default');
  assert.equal(evidence.execution.finalWorkflowTimezoneEtcUTC, true);
  assert.equal(evidence.execution.timezoneSavedAndReadBack, true);
  assert.equal(evidence.execution.scheduleActive, false);
  assert.equal(evidence.execution.publishClicked, false);
  assert.equal(evidence.template.publicTemplateIdAvailable, false);
  assert.equal(evidence.template.publicTemplateUrlAvailable, false);
  assert.equal(evidence.claimBoundaries.twoClickSetup, false);
  assert.equal(evidence.claimBoundaries.clickToRun, false);

  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(
    serialized,
    /"(?:workspaceId|accountId|spreadsheetId|actorRunId|datasetRunId|executionId)"\s*:/i,
  );
  assert.doesNotMatch(serialized, /Bearer\s+|apify_api_|"rawResponse"\s*:/);
});
