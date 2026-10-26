import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPublicAssets } from '../installer/build-public-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('public asset build copies only browser files and the shared four-square banner', async (t) => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'meka-public-assets-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  await buildPublicAssets(output);

  const entries = await readdir(output, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(output, path.join(entry.parentPath, entry.name)))
    .sort();
  assert.ok(files.includes('index.html'));
  assert.ok(files.includes('app.js'));
  assert.ok(files.includes('generated/workflow-template.js'));
  assert.ok(files.includes('assets/banner.svg'));
  assert.equal(files.some((file) => (
    file === 'server.mjs'
    || file.startsWith('worker/')
    || file.endsWith('relay-policy.js')
    || file.endsWith('security-headers.js')
    || file.includes('node_modules')
    || file.endsWith('package-lock.json')
    || file.endsWith('.lock')
    || file.endsWith('.toml')
  )), false);
  assert.equal(files.every((file) => ['.html', '.css', '.js', '.svg'].includes(path.extname(file))), true);

  const builtBanner = await readFile(path.join(output, 'assets', 'banner.svg'));
  const sourceBanner = await readFile(path.join(root, 'assets', 'banner.svg'));
  assert.equal(
    createHash('sha256').update(builtBanner).digest('hex'),
    createHash('sha256').update(sourceBanner).digest('hex'),
  );
  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.match(html, /src="assets\/banner\.svg"/u);
  assert.match(html, /class="brand-mark"[\s\S]*<i><\/i>[\s\S]*<i><\/i>[\s\S]*<i><\/i>[\s\S]*<i><\/i>/u);
});

test('Worker configuration uses the MEKA custom domain and keeps default endpoints disabled', async () => {
  const config = await readFile(path.join(root, 'installer', 'wrangler.toml'), 'utf8');
  assert.match(config, /^name\s*=\s*"meka-n8n-installer"$/mu);
  assert.match(config, /^main\s*=\s*"worker\/index\.mjs"$/mu);
  assert.match(config, /^workers_dev\s*=\s*false$/mu);
  assert.match(config, /^preview_urls\s*=\s*false$/mu);
  assert.match(
    config,
    /^routes\s*=\s*\[\s*\{\s*pattern\s*=\s*"install\.meka\.im"\s*,\s*custom_domain\s*=\s*true\s*\}\s*\]$/mu,
  );
  assert.equal((config.match(/^\s*\{\s*pattern\s*=/gmu) ?? []).length, 1);
  assert.doesNotMatch(config, /workers\.dev/u);
  assert.match(config, /^run_worker_first\s*=\s*true$/mu);
  assert.match(
    config,
    /\[\[ratelimits\]\][\s\S]*name\s*=\s*"MCP_RATE_LIMITER"[\s\S]*namespace_id\s*=\s*"2601026"[\s\S]*limit\s*=\s*60[\s\S]*period\s*=\s*60/u,
  );
  assert.match(config, /\[observability\][\s\S]*enabled\s*=\s*false/u);
});
