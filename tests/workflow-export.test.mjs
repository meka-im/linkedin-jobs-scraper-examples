import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';
import { loadWorkflow, nodeByName, root } from './helpers.mjs';

let workflow;
test.before(async () => {
  workflow = await loadWorkflow();
});

test('export is inactive, unpinned, built-in only, and scheduled for 08:00 UTC', () => {
  assert.equal(workflow.active, false);
  assert.equal(Object.hasOwn(workflow, 'pinData'), false);
  assert.equal(workflow.settings.timezone, 'UTC');
  assert.equal(new Set(workflow.nodes.map(({ name }) => name)).size, workflow.nodes.length);
  assert.equal(
    workflow.nodes.every(({ type }) => type.startsWith('n8n-nodes-base.')),
    true,
  );

  const schedule = nodeByName(workflow, 'Daily Schedule');
  assert.equal(schedule.type, 'n8n-nodes-base.scheduleTrigger');
  assert.deepEqual(schedule.parameters.rule.interval[0], {
    field: 'days',
    daysInterval: 1,
    triggerAtHour: 8,
    triggerAtMinute: 0,
  });
});

test('all Apify HTTP nodes use header auth without embedded credentials and preserve full responses', () => {
  for (const name of ['Start Actor', 'Poll Actor Run', 'Get Run Output', 'Get Dataset Items']) {
    const node = nodeByName(workflow, name);
    assert.equal(node.type, 'n8n-nodes-base.httpRequest');
    assert.equal(node.parameters.authentication, 'genericCredentialType');
    assert.equal(node.parameters.genericAuthType, 'httpHeaderAuth');
    assert.equal(node.parameters.options.response.response.fullResponse, true);
    assert.equal(Object.hasOwn(node, 'credentials'), false);
    assert.equal(node.retryOnFail, false);
  }

  const start = nodeByName(workflow, 'Start Actor');
  assert.equal(start.parameters.method, 'POST');
  assert.equal(
    start.parameters.url,
    'https://api.apify.com/v2/acts/meka.im~linkedin-jobs-scraper/runs',
  );
  assert.match(
    nodeByName(workflow, 'Get Run Output').parameters.url,
    /records\/OUTPUT/,
  );
});

test('Google Sheets v4.7 read and append use configurable IDs and RAW explicit mappings', async () => {
  const read = nodeByName(workflow, 'Read Existing Jobs');
  const append = nodeByName(workflow, 'Append Rows');

  for (const node of [read, append]) {
    assert.equal(node.type, 'n8n-nodes-base.googleSheets');
    assert.equal(node.typeVersion, 4.7);
    assert.equal(node.parameters.documentId.__rl, true);
    assert.equal(node.parameters.documentId.mode, 'id');
    assert.match(node.parameters.documentId.value, /sheetId/);
    assert.equal(node.parameters.sheetName.__rl, true);
    assert.equal(node.parameters.sheetName.mode, 'name');
    assert.match(node.parameters.sheetName.value, /sheetName/);
    assert.equal(Object.hasOwn(node, 'credentials'), false);
  }

  assert.equal(read.parameters.operation, 'read');
  assert.equal(read.alwaysOutputData, true);
  assert.equal(append.parameters.operation, 'append');
  assert.equal(append.parameters.options.cellFormat, 'RAW');
  assert.equal(append.parameters.columns.mappingMode, 'defineBelow');
  assert.equal(Object.hasOwn(append.parameters.columns, 'matchingColumns'), false);
  assert.equal(append.parameters.columns.schema.length, 10);
  assert.deepEqual(
    Object.keys(append.parameters.columns.value),
    append.parameters.columns.schema.map(({ id }) => id),
  );

  const header = await readFile(path.join(root, 'sheets', 'jobs-header.csv'), 'utf8');
  assert.equal(header.trim(), append.parameters.columns.schema.map(({ id }) => id).join(','));
});

test('workflow has a bounded poll loop and does not turn an empty dataset into an error', () => {
  assert.deepEqual(
    workflow.connections['Assess Polled Run'].main[0],
    [{ node: 'Is Run Succeeded?', type: 'main', index: 0 }],
  );
  assert.deepEqual(
    workflow.connections['Is Run Succeeded?'].main,
    [
      [{ node: 'Get Run Output', type: 'main', index: 0 }],
      [{ node: 'Wait for Actor', type: 'main', index: 0 }],
    ],
  );
  assert.deepEqual(
    workflow.connections['Assess Run Output'].main[0],
    [{ node: 'Get Dataset Items', type: 'main', index: 0 }],
  );
  assert.equal(nodeByName(workflow, 'Wait for Actor').parameters.resume, 'timeInterval');
  assert.equal(
    nodeByName(workflow, 'Get Dataset Items').parameters.options.response.response.fullResponse,
    true,
  );
  assert.deepEqual(
    nodeByName(workflow, 'Normalize Jobs').parameters.mode,
    'runOnceForAllItems',
  );
});

test('sticky note explains both credential types, header setup, and configuration', () => {
  const content = nodeByName(workflow, 'Before Running').parameters.content;
  assert.match(content, /Authorization/);
  assert.match(content, /Bearer <APIFY_TOKEN>/);
  assert.match(content, /Google Sheets OAuth/);
  assert.match(content, /jobs-header\.csv/);
  assert.match(content, /document ID/);
  assert.match(content, /08:00 UTC/);
});

test('export contains no credential objects, bearer values, spreadsheet ID, or pin data', async () => {
  const serialized = JSON.stringify(workflow);
  for (const node of workflow.nodes) {
    assert.equal(Object.hasOwn(node, 'credentials'), false, `${node.name} embeds credentials`);
  }
  assert.doesNotMatch(serialized, /Bearer\s+(?!<)[A-Za-z0-9._~-]{8,}/);
  assert.doesNotMatch(serialized, /apify_api_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(serialized, /spreadsheetId/i);
  assert.doesNotMatch(serialized, /"pinData"\s*:/);

  const envExample = await readFile(path.join(root, '.env.example'), 'utf8');
  assert.match(envExample, /^APIFY_TOKEN=\s*$/m);
});

test('sample input and all example scripts use the documented request payload', async () => {
  const input = JSON.parse(await readFile(path.join(root, 'examples', 'input.json'), 'utf8'));
  assert.deepEqual(input, {
    keywords: 'software engineer',
    location: 'London, United Kingdom',
    datePosted: 'pastWeek',
    count: 10,
    limitPerSource: 10,
    scrapeCompany: false,
  });

  const shellCheck = spawnSync('bash', ['-n', path.join(root, 'examples', 'curl.sh')], {
    encoding: 'utf8',
  });
  assert.equal(shellCheck.status, 0, shellCheck.stderr);

  const curlSource = await readFile(path.join(root, 'examples', 'curl.sh'), 'utf8');
  assert.match(curlSource, /records\/OUTPUT/);
});
