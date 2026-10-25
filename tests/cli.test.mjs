import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  formatLocalN8nSuccess,
  readHiddenToken,
  redactSecrets,
  runCli as runCliInProcess,
} from '../bin/meka-jobs.mjs';
import { root } from './helpers.mjs';

const token = 'cli-test-token-not-a-real-secret';
const fixture = path.join(root, 'tests', 'fixtures', 'cli-fetch.cjs');
const cli = path.join(root, 'bin', 'meka-jobs.mjs');

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env };
  delete environment.APIFY_TOKEN;
  delete environment.MEKA_TEST_FETCH_MODE;
  return { ...environment, ...extra };
}

function runCli(args, {
  cwd = root,
  apiToken,
  mode = 'no-network',
  stdin,
} = {}) {
  return spawnSync(
    process.execPath,
    ['--require', fixture, cli, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: cleanEnvironment({
        MEKA_TEST_FETCH_MODE: mode,
        ...(apiToken === undefined ? {} : { APIFY_TOKEN: apiToken }),
      }),
      input: stdin,
      timeout: 10_000,
    },
  );
}

class FakeTtyInput extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.modeChanges = [];
    this.paused = false;
  }

  setRawMode(value) {
    this.isRaw = value;
    this.modeChanges.push(value);
  }

  resume() {}

  pause() {
    this.paused = true;
  }
}

function fakeTtyOutput() {
  const chunks = [];
  return {
    isTTY: true,
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
}

test('help exits without a token or a network request', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /npx --yes --package=github:/);
  assert.match(result.stdout, /meka-jobs n8n/);
  assert.match(result.stdout, /USD 0\.05/);
  assert.equal(result.stderr, '');
});

test('n8n help documents the fixed local resources without starting Docker', () => {
  const result = runCli(['n8n', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Docker Desktop or Docker Engine/);
  assert.match(result.stdout, /n8nio\/n8n:2\.44\.6/);
  assert.match(result.stdout, /127\.0\.0\.1:<port>:5678/);
  assert.match(result.stdout, /No credentials are injected/);
  assert.equal(result.stderr, '');
});

test('n8n rejects an invalid port before invoking Docker', () => {
  const result = runCli(['n8n', '--port', '65536']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--port must be an integer from 1 to 65535/);
  assert.doesNotMatch(result.stderr, /Docker daemon/);
});

test('n8n success output gives the URL, first-run steps, and safe lifecycle commands', () => {
  const output = formatLocalN8nSuccess({
    url: 'http://localhost:5678',
    containerName: 'meka-linkedin-jobs-n8n',
    volumeName: 'meka-linkedin-jobs-n8n-data',
  });
  assert.match(output, /http:\/\/localhost:5678/);
  assert.match(output, /workflow is pre-imported/);
  assert.match(output, /owner account setup/);
  assert.match(output, /Google Sheets and Apify credentials/);
  assert.match(output, /docker stop meka-linkedin-jobs-n8n/);
  assert.match(output, /docker start meka-linkedin-jobs-n8n/);
  assert.match(output, /Persistent data: Docker volume/);
  assert.doesNotMatch(output, /docker (?:rm|volume rm|system prune)/);
});

test('normal API and n8n runs reject old Node before dependencies or requests', async () => {
  const stdin = new FakeTtyInput();
  const n8nStdout = fakeTtyOutput();
  const n8nStderr = fakeTtyOutput();
  const n8nCode = await runCliInProcess({
    argv: ['n8n'],
    env: {},
    stdin,
    stdout: n8nStdout,
    stderr: n8nStderr,
    nodeVersion: '20.19.0',
  });
  assert.equal(n8nCode, 1);
  assert.match(n8nStderr.chunks.join(''), /Node\.js 22 or newer is required/);
  assert.doesNotMatch(n8nStdout.chunks.join(''), /Starting local n8n/);

  const apiStdout = fakeTtyOutput();
  const apiStderr = fakeTtyOutput();
  const apiCode = await runCliInProcess({
    argv: ['--yes'],
    env: {},
    stdin,
    stdout: apiStdout,
    stderr: apiStderr,
    nodeVersion: '20.19.0',
  });
  assert.equal(apiCode, 1);
  assert.match(apiStderr.chunks.join(''), /No request was started/);

  const helpStdout = fakeTtyOutput();
  const helpCode = await runCliInProcess({
    argv: ['--help'],
    env: {},
    stdin,
    stdout: helpStdout,
    stderr: fakeTtyOutput(),
    nodeVersion: '20.19.0',
  });
  assert.equal(helpCode, 0);
  assert.match(helpStdout.chunks.join(''), /Usage:/);
});

test('--check reports configuration without exposing the token or using the network', () => {
  const configured = runCli(['--check'], { apiToken: token });
  assert.equal(configured.status, 0, configured.stderr);
  assert.match(configured.stdout, /APIFY_TOKEN: configured/);
  assert.match(configured.stdout, /Network access: skipped/);
  assert.doesNotMatch(configured.stdout + configured.stderr, new RegExp(token));

  const missing = runCli(['--check']);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /APIFY_TOKEN: not configured/);
  assert.match(missing.stdout, /Check failed/);
});

test('a non-TTY run without a token fails clearly without hanging or using the network', () => {
  const result = runCli(['--yes']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APIFY_TOKEN is not configured/);
  assert.doesNotMatch(result.stderr, /Network access is forbidden/);
});

test('invalid input and unwritable output fail before the API is called', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'meka-cli-preflight-'));
  try {
    const badInput = path.join(temporary, 'bad-input.json');
    await writeFile(badInput, JSON.stringify({
      keywords: 'engineer',
      count: 0,
      limitPerSource: 10,
    }));

    const invalidInput = runCli(
      ['--yes', '--input', badInput, '--output', path.join(temporary, 'jobs.json')],
      { apiToken: token },
    );
    assert.equal(invalidInput.status, 1);
    assert.match(invalidInput.stderr, /input\.count must be a positive integer/);
    assert.doesNotMatch(invalidInput.stderr, /Network access is forbidden/);

    const badOutput = runCli(
      [
        '--yes',
        '--input',
        path.join(root, 'examples', 'input.json'),
        '--output',
        path.join(temporary, 'missing', 'jobs.json'),
      ],
      { apiToken: token },
    );
    assert.equal(badOutput.status, 1);
    assert.match(badOutput.stderr, /Cannot use output directory/);
    assert.doesNotMatch(badOutput.stderr, /Network access is forbidden/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('--yes does not authorize replacing an existing output', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'meka-cli-overwrite-'));
  const output = path.join(temporary, 'jobs.json');
  try {
    await writeFile(output, 'keep-existing\n');
    const result = runCli(['--yes', '--output', output], { apiToken: token });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /already exists/);
    assert.match(result.stderr, /--yes does not authorize/);
    assert.equal(await readFile(output, 'utf8'), 'keep-existing\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('mock API success writes the result JSON and preserves the run summary', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'meka-cli-success-'));
  const output = path.join(temporary, 'jobs.json');
  try {
    const result = runCli(
      [
        '--yes',
        '--input',
        path.join(root, 'examples', 'input.json'),
        '--output',
        output,
      ],
      { apiToken: token, mode: 'success', cwd: temporary },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Requested results: up to 10/);
    assert.match(result.stdout, /Hard maximum Actor charge: USD 0\.05/);
    assert.match(result.stdout, /public LinkedIn job posts only/);
    assert.match(result.stdout, /Run summary:/);
    const jobs = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, '4391073032');
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a partial Actor result is saved with the existing warning', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'meka-cli-partial-'));
  const output = path.join(temporary, 'jobs.json');
  try {
    const result = runCli(
      ['--yes', '--output', output],
      { apiToken: token, mode: 'partial', cwd: temporary },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Warning: the Actor run was partial/);
    const summaryLine = result.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith('Run summary: '));
    assert.ok(summaryLine);
    assert.equal(JSON.parse(summaryLine.slice('Run summary: '.length)).coverage, 'partial');
    assert.equal((await readFile(output, 'utf8')).includes('CLI Test Engineer'), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('API errors are redacted and an existing output survives a failed run', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'meka-cli-error-'));
  const output = path.join(temporary, 'jobs.json');
  try {
    await writeFile(output, 'previous successful result\n');
    const result = runCli(
      ['--yes', '--overwrite', '--output', output],
      { apiToken: token, mode: 'error', cwd: temporary },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[REDACTED\]/);
    assert.doesNotMatch(result.stderr, new RegExp(token));
    assert.equal(await readFile(output, 'utf8'), 'previous successful result\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('hidden token entry restores terminal state and never echoes the secret', async () => {
  const stdin = new FakeTtyInput();
  const stdout = fakeTtyOutput();
  const signals = new EventEmitter();
  const pending = readHiddenToken({ stdin, stdout, signalSource: signals });

  assert.equal(stdin.isRaw, true);
  stdin.emit('data', Buffer.from('hidden-secret-token\r'));
  assert.equal(await pending, 'hidden-secret-token');
  assert.equal(stdin.isRaw, false);
  assert.deepEqual(stdin.modeChanges, [true, false]);
  assert.equal(stdout.chunks.join('').includes('hidden-secret-token'), false);
  assert.equal(stdin.paused, true);
});

test('hidden token entry restores terminal state on input errors and SIGINT', async () => {
  const errorInput = new FakeTtyInput();
  const errorOutput = fakeTtyOutput();
  const errorSignals = new EventEmitter();
  const failed = readHiddenToken({
    stdin: errorInput,
    stdout: errorOutput,
    signalSource: errorSignals,
  });
  errorInput.emit('error', new Error('read failed'));
  await assert.rejects(failed, /Could not read APIFY_TOKEN/);
  assert.equal(errorInput.isRaw, false);

  const interruptedInput = new FakeTtyInput();
  const interruptedOutput = fakeTtyOutput();
  const interruptedSignals = new EventEmitter();
  const interrupted = readHiddenToken({
    stdin: interruptedInput,
    stdout: interruptedOutput,
    signalSource: interruptedSignals,
  });
  interruptedSignals.emit('SIGINT');
  await assert.rejects(
    interrupted,
    (error) => error.exitCode === 130 && /Cancelled/.test(error.message),
  );
  assert.equal(interruptedInput.isRaw, false);
});

test('hidden token entry restores terminal state when stdin ends or closes', async () => {
  for (const event of ['end', 'close']) {
    const input = new FakeTtyInput();
    const output = fakeTtyOutput();
    const signals = new EventEmitter();
    const pending = readHiddenToken({
      stdin: input,
      stdout: output,
      signalSource: signals,
    });

    assert.equal(input.isRaw, true);
    input.emit(event);
    await assert.rejects(pending, /input (?:ended|closed) before a token was entered/);
    assert.equal(input.isRaw, false);
    assert.deepEqual(input.modeChanges, [true, false]);
    assert.equal(input.paused, true);
  }
});

test('redaction removes raw and Authorization token forms', () => {
  const secret = 'a-secret-token-value';
  const message = redactSecrets(
    `Authorization: Bearer ${secret}; raw=${secret}; encoded=${encodeURIComponent(secret)}`,
    secret,
  );
  assert.doesNotMatch(message, new RegExp(secret));
  assert.doesNotMatch(message, /a-secret-token-value/);
  assert.match(message, /\[REDACTED\]/);
});

test('package metadata exports meka-jobs and includes runtime files', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['meka-jobs'], './bin/meka-jobs.mjs');
  assert.equal(packageJson.files.includes('bin/'), true);
  assert.equal(packageJson.files.includes('src/'), true);
  assert.equal(packageJson.files.includes('examples/input.json'), true);
  assert.equal(
    packageJson.files.includes('n8n/linkedin-jobs-to-google-sheets.json'),
    true,
  );
});
