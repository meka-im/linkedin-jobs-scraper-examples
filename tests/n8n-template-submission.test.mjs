import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  beforeRunningStickyId,
  buildTemplateWorkflow,
  sourceWorkflowPath,
  templateStickyContent,
  templateTitle,
  templateWorkflowPath,
} from '../scripts/build-n8n-template.mjs';

const sourceText = await readFile(sourceWorkflowPath, 'utf8');
const source = JSON.parse(sourceText);
const template = JSON.parse(await readFile(templateWorkflowPath, 'utf8'));

function stickyById(workflow, id) {
  return workflow.nodes.find((node) => node.id === id);
}

test('template name and yellow setup sticky follow the submission requirements', () => {
  assert.equal(template.name, templateTitle);

  const sticky = stickyById(template, beforeRunningStickyId);
  assert.equal(sticky?.type, 'n8n-nodes-base.stickyNote');
  assert.equal(sticky.parameters.content, templateStickyContent);

  for (const heading of [
    'Who it is for',
    'How it works',
    'Setup',
    'Requirements',
    'Customize',
  ]) {
    assert.match(sticky.parameters.content, new RegExp(`\\*\\*${heading}:\\*\\*`));
  }
  assert.match(
    sticky.parameters.content,
    /https:\/\/github\.com\/meka-im\/linkedin-jobs-scraper-examples/,
  );
  assert.match(
    sticky.parameters.content,
    /https:\/\/apify\.com\/meka\.im\/linkedin-jobs-scraper/,
  );
  assert.match(sticky.parameters.content, /Workflow settings -> Timezone/);
  assert.match(sticky.parameters.content, /Etc\/UTC/);
  assert.match(sticky.parameters.content, /your local timezone/);
  assert.match(sticky.parameters.content, /08:00/);
  assert.match(sticky.parameters.content, /instance default/);
  for (const header of [
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
  ]) {
    assert.ok(sticky.parameters.content.includes(`\`${header}\``), `missing header ${header}`);
  }
  for (const nodeName of [
    'Start Actor',
    'Poll Actor Run',
    'Get Run Output',
    'Get Dataset Items',
  ]) {
    assert.ok(sticky.parameters.content.includes(`**${nodeName}**`), `missing node ${nodeName}`);
  }

  const wordCount = sticky.parameters.content
    .replace(/https?:\/\/\S+/gu, '')
    .match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/gu)?.length ?? 0;
  assert.ok(wordCount >= 220 && wordCount <= 260, `expected 220-260 words, got ${wordCount}`);
});

test('template preserves every executable node, ID, connection, activation flag, and setting', () => {
  assert.equal(source.settings.timezone, 'UTC');
  assert.equal(template.active, source.active);
  assert.deepEqual(template.settings, source.settings);
  assert.deepEqual(template.connections, source.connections);

  const sourceExecutable = source.nodes.filter(
    ({ type }) => type !== 'n8n-nodes-base.stickyNote',
  );
  const templateExecutable = template.nodes.filter(
    ({ type }) => type !== 'n8n-nodes-base.stickyNote',
  );
  assert.deepEqual(templateExecutable, sourceExecutable);

  const sourceSticky = stickyById(source, beforeRunningStickyId);

  const restored = structuredClone(template);
  restored.name = source.name;
  restored.nodes = restored.nodes.map((node) => (
    node.id === beforeRunningStickyId
      ? structuredClone(sourceSticky)
      : node
  ));
  assert.deepEqual(restored, source);
});

test('template is reproducible and keeps the accepted public source hash', () => {
  assert.deepEqual(buildTemplateWorkflow(source), template);
  assert.equal(
    createHash('sha256').update(sourceText).digest('hex'),
    '8823e9720a601683197fff35a30586343f58632515e1854d7f13cd417f2299ac',
  );
  assert.equal(
    path.basename(sourceWorkflowPath),
    'linkedin-jobs-to-google-sheets.json',
  );
  assert.equal(
    path.basename(templateWorkflowPath),
    'linkedin-jobs-to-google-sheets-template.json',
  );
});

test('template contains no embedded credentials, private identifiers, or pin data', () => {
  const serialized = JSON.stringify(template);
  for (const node of template.nodes) {
    assert.equal(Object.hasOwn(node, 'credentials'), false, `${node.name} embeds credentials`);
  }
  assert.equal(Object.hasOwn(template, 'pinData'), false);
  assert.doesNotMatch(serialized, /Bearer\s+(?!<)[A-Za-z0-9._~-]{8,}/);
  assert.doesNotMatch(serialized, /apify_api_[A-Za-z0-9_-]+/);
  assert.doesNotMatch(serialized, /spreadsheetId/i);
  assert.doesNotMatch(serialized, /docs\.google\.com\/spreadsheets\/d\//i);
  assert.doesNotMatch(serialized, /"pinData"\s*:/);
});
