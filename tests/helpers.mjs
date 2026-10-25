import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadWorkflow() {
  return JSON.parse(
    await readFile(path.join(root, 'n8n', 'linkedin-jobs-to-google-sheets.json'), 'utf8'),
  );
}

export function nodeByName(workflow, name) {
  const found = workflow.nodes.find((node) => node.name === name);
  if (!found) throw new Error(`Workflow node not found: ${name}`);
  return found;
}

export function asItems(items) {
  return items.map((json) => ({ json }));
}

export async function executeN8nCode(jsCode, { input = [], named = {} } = {}) {
  const inputItems = asItems(input);
  const normalizeItems = (items) => asItems(items);
  const context = {
    $input: {
      all: () => inputItems,
      first: () => inputItems[0],
      last: () => inputItems.at(-1),
    },
    $: (name) => {
      const items = normalizeItems(named[name] ?? []);
      return {
        all: () => items,
        first: () => items[0],
        last: () => items.at(-1),
      };
    },
  };
  const script = new vm.Script(`(async () => {\n${jsCode}\n})()`, {
    filename: 'embedded-n8n-code.js',
  });
  const output = await script.runInNewContext(context);
  return JSON.parse(JSON.stringify(output));
}

export const settings = {
  keywords: 'software engineer',
  location: 'London, United Kingdom',
  datePosted: 'pastWeek',
  limit: 25,
  count: 25,
  limitPerSource: 25,
  scrapeCompany: false,
  budgetUsd: 0.05,
  sheetId: 'test_sheet_id',
  sheetName: 'Jobs',
  actorTimeoutSeconds: 300,
  waitForFinishSeconds: 60,
  pollDelaySeconds: 5,
  maxPollAttempts: 6,
  runDeadlineEpochMs: Date.now() + 480_000,
};

export function job(id, overrides = {}) {
  return {
    id: String(id),
    title: `Engineer ${id}`,
    company: 'Example Co',
    location: 'London, United Kingdom',
    postedAt: '2026-10-24',
    url: `https://www.linkedin.com/jobs/view/${id}`,
    salary: '',
    employmentType: 'Full-time',
    seniority: 'Mid-Senior level',
    firstSeenAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}
