import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { root } from './helpers.mjs';

test('curl example validates count before invoking curl', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'meka-curl-test-'));
  const marker = path.join(temporary, 'curl-was-called');
  const fakeCurl = path.join(temporary, 'curl');
  const input = path.join(temporary, 'invalid-input.json');

  try {
    await writeFile(
      fakeCurl,
      `#!/usr/bin/env bash\nprintf called > ${JSON.stringify(marker)}\nexit 99\n`,
      'utf8',
    );
    await chmod(fakeCurl, 0o755);
    await writeFile(
      input,
      JSON.stringify({
        keywords: 'software engineer',
        count: 0,
        limitPerSource: 10,
      }),
      'utf8',
    );

    const result = spawnSync('bash', [path.join(root, 'examples', 'curl.sh'), input], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APIFY_TOKEN: 'test-token-not-a-real-secret',
        PATH: `${temporary}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /input\.count must be a positive integer/);
    await assert.rejects(access(marker, constants.F_OK));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
