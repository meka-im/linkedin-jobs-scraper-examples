import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { root } from './helpers.mjs';

test('JavaScript CLI prints the Run summary and a partial-coverage warning', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'meka-js-cli-test-'));
  const output = path.join(temporary, 'jobs.json');

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        path.join(root, 'tests', 'fixtures', 'javascript-cli-partial-fetch.cjs'),
        path.join(root, 'examples', 'javascript.mjs'),
        path.join(root, 'examples', 'input.json'),
        output,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          APIFY_TOKEN: 'test-token-not-a-real-secret',
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const summaryLine = result.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith('Run summary: '));
    assert.ok(summaryLine, 'CLI did not print a Run summary');
    const summary = JSON.parse(summaryLine.slice('Run summary: '.length));
    assert.equal(summary.coverage, 'partial');
    assert.equal(summary.failedJobDetails, 2);
    assert.match(result.stderr, /Warning: the Actor run was partial/);

    const jobs = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, '4391073032');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
