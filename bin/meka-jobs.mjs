#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  access,
  link,
  lstat,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLinkedInJobs } from '../src/apify-client.mjs';
import {
  N8N_CONTAINER_NAME,
  N8N_DEFAULT_PORT,
  N8N_IMAGE,
  N8N_VOLUME_NAME,
  startLocalN8n,
} from '../src/local-n8n.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const defaultInputPath = path.join(packageRoot, 'examples', 'input.json');
const defaultOutputName = 'jobs.json';
const maximumChargeUsd = '0.05';

const helpText = `MEKA LinkedIn Jobs

Usage:
  npx --yes --package=github:meka-im/linkedin-jobs-scraper-examples meka-jobs [options]
  npx --yes --package=github:meka-im/linkedin-jobs-scraper-examples meka-jobs n8n [--port <port>]

Commands:
  n8n              Start visual n8n locally and pre-import the bundled workflow

Options:
  --input <file>   Actor input JSON (default: bundled London software engineer demo)
  --output <file>  Result JSON path (default: ./jobs.json)
  --check          Check Node.js and APIFY_TOKEN configuration; never uses the network
  --yes            Accept the Apify request and its charge cap without a confirmation prompt
  --overwrite      Allow replacing an existing output file after a successful run
  --help           Show this help

APIFY_TOKEN may be supplied in the environment. If it is missing, an interactive
terminal asks for it with echo disabled. The token is never written to disk or
included in request URLs.

The default demo requests up to 10 public LinkedIn jobs. Every Actor run has a
hard charge cap of USD 0.05. A non-interactive run requires --yes. --yes does not
authorize replacing an existing output file.
`;

const n8nHelpText = `MEKA LinkedIn Jobs - local n8n

Usage:
  npx --yes --package=github:meka-im/linkedin-jobs-scraper-examples meka-jobs n8n [options]

Options:
  --port <port>    Loopback port from 1 to 65535 (default: 5678)
  --help           Show this help

Requirements:
  Docker Desktop or Docker Engine must be installed and its daemon must be running.

The command uses ${N8N_IMAGE}, container ${N8N_CONTAINER_NAME}, and persistent volume
${N8N_VOLUME_NAME}. It only publishes 127.0.0.1:<port>:5678, runs n8n as the
official node user, and copies the bundled workflow into the container for one-time
import without retaining an npx cache path. Existing MEKA data is retained across
stop, start, and CLI failures while the pinned image and workflow baseline match.
This command does not automatically upgrade either resource or re-import a changed
workflow; a baseline change requires an explicit migration.
No credentials are injected and no schedule is activated.
`;

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

function optionValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined) {
    if (!inlineValue) throw new CliError(`${name} requires a value`, 2);
    return { value: inlineValue, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new CliError(`${name} requires a value`, 2);
  }
  return { value, nextIndex: index + 1 };
}

export function parseArgs(argv) {
  const options = {
    command: 'api',
    help: false,
    check: false,
    yes: false,
    overwrite: false,
    input: null,
    output: null,
    port: null,
  };

  let index = 0;
  if (argv[0] && !argv[0].startsWith('--')) {
    if (argv[0] !== 'n8n') {
      throw new CliError(`Unknown command: ${argv[0]}`, 2);
    }
    options.command = 'n8n';
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new CliError(`Unexpected positional argument: ${argument}`, 2);
    }

    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);

    if (name === '--help' || name === '--check' || name === '--yes' || name === '--overwrite') {
      if (inlineValue !== undefined) {
        throw new CliError(`${name} does not take a value`, 2);
      }
      options[name.slice(2)] = true;
      continue;
    }

    if (name === '--input' || name === '--output' || name === '--port') {
      const result = optionValue(argv, index, name, inlineValue);
      options[name.slice(2)] = result.value;
      index = result.nextIndex;
      continue;
    }

    throw new CliError(`Unknown option: ${name}`, 2);
  }

  if (options.port !== null) {
    if (!/^[0-9]+$/u.test(options.port)) {
      throw new CliError('--port must be an integer from 1 to 65535.', 2);
    }
    options.port = Number(options.port);
    if (options.port < 1 || options.port > 65_535) {
      throw new CliError('--port must be an integer from 1 to 65535.', 2);
    }
  }
  if (options.command === 'n8n') {
    const unsupported = ['check', 'yes', 'overwrite', 'input', 'output'].find(
      (key) => options[key] !== false && options[key] !== null,
    );
    if (unsupported) {
      throw new CliError(
        `--${unsupported} is not supported by the n8n command.`,
        2,
      );
    }
  } else if (options.port !== null) {
    throw new CliError('--port is only supported by the n8n command.', 2);
  }

  return options;
}

function isInteractive(stdin, stdout) {
  return stdin.isTTY === true && stdout.isTTY === true;
}

async function askYesNo(question, {
  stdin = process.stdin,
  stdout = process.stdout,
  signalSource = process,
} = {}) {
  const readline = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
  });
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    readline.close();
  };
  readline.once('SIGINT', interrupt);
  signalSource.once('SIGINT', interrupt);

  try {
    const answer = await readline.question(question);
    return /^(?:y|yes)$/iu.test(answer.trim());
  } catch (error) {
    if (interrupted) throw new CliError('Cancelled; no Apify request was made.', 130);
    throw error;
  } finally {
    signalSource.off('SIGINT', interrupt);
    readline.close();
  }
}

export async function readHiddenToken({
  stdin = process.stdin,
  stdout = process.stdout,
  signalSource = process,
} = {}) {
  if (!isInteractive(stdin, stdout)) {
    throw new CliError(
      'APIFY_TOKEN is not configured and stdin/stdout is not an interactive terminal.',
    );
  }
  if (typeof stdin.setRawMode !== 'function') {
    throw new CliError('This terminal cannot disable token echo.');
  }

  stdout.write('APIFY_TOKEN (input hidden): ');
  const previousRawMode = stdin.isRaw === true;
  let characters = '';

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('error', onError);
      stdin.off('end', onEnd);
      stdin.off('close', onClose);
      signalSource.off('SIGINT', onSignal);
      try {
        stdin.setRawMode(previousRawMode);
      } finally {
        stdin.pause();
      }
    };

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      try {
        cleanup();
      } catch (cleanupError) {
        reject(new CliError(`Could not restore terminal input: ${cleanupError.message}`));
        return;
      }
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onSignal = () => {
      finish(new CliError('Cancelled; no Apify request was made.', 130));
    };

    const onError = (error) => {
      finish(new CliError(`Could not read APIFY_TOKEN: ${error.message}`));
    };

    const onEnd = () => {
      finish(new CliError('APIFY_TOKEN input ended before a token was entered.'));
    };

    const onClose = () => {
      finish(new CliError('APIFY_TOKEN input closed before a token was entered.'));
    };

    const onData = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      for (const character of text) {
        const codePoint = character.codePointAt(0);
        if (codePoint === 3 || codePoint === 4) {
          finish(new CliError('Cancelled; no Apify request was made.', 130));
          return;
        }
        if (character === '\r' || character === '\n') {
          const token = characters.trim();
          if (!token) {
            finish(new CliError('APIFY_TOKEN cannot be empty.'));
          } else {
            finish(null, token);
          }
          return;
        }
        if (codePoint === 8 || codePoint === 127) {
          characters = characters.slice(0, -1);
          continue;
        }
        if (codePoint >= 32) characters += character;
      }
    };

    stdin.on('data', onData);
    stdin.once('error', onError);
    stdin.once('end', onEnd);
    stdin.once('close', onClose);
    signalSource.once('SIGINT', onSignal);
    try {
      stdin.setRawMode(true);
      stdin.resume();
    } catch (error) {
      finish(new CliError(`Could not disable token echo: ${error.message}`));
    }
  });
}

function checkRuntime({ version, token, stdout }) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  const nodeOk = Number.isInteger(major) && major >= 22;
  const tokenOk = Boolean(token);

  stdout.write(`Node.js: ${version} (${nodeOk ? 'supported' : 'requires Node.js 22 or newer'})\n`);
  stdout.write(`APIFY_TOKEN: ${tokenOk ? 'configured' : 'not configured'}\n`);
  stdout.write('Network access: skipped\n');
  stdout.write('Actor runs or charges started: 0\n');

  if (nodeOk && tokenOk) {
    stdout.write('Check passed. No network request was made.\n');
    return 0;
  }
  stdout.write('Check failed. See the status above.\n');
  return 1;
}

function assertSupportedNodeVersion(version) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new CliError(
      `Node.js 22 or newer is required; this runtime is ${version}. No request was started.`,
    );
  }
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CliError('Input must be a JSON object.');
  }
  if (!Number.isInteger(input.count) || input.count < 1) {
    throw new CliError('input.count must be a positive integer.');
  }
  if (!Number.isInteger(input.limitPerSource) || input.limitPerSource < 1) {
    throw new CliError('input.limitPerSource must be a positive integer.');
  }
  const hasKeywords = typeof input.keywords === 'string' && input.keywords.trim();
  const hasUrls = Array.isArray(input.urls) && input.urls.length > 0;
  const hasCompanies = Array.isArray(input.companyIds) && input.companyIds.length > 0;
  if (!hasKeywords && !hasUrls && !hasCompanies) {
    throw new CliError('Input must include keywords, urls, or companyIds.');
  }
  if (
    input.datePosted !== undefined
    && !['anyTime', 'past24Hours', 'pastWeek', 'pastMonth'].includes(input.datePosted)
  ) {
    throw new CliError('input.datePosted has an unsupported value.');
  }
  if (input.scrapeCompany !== undefined && typeof input.scrapeCompany !== 'boolean') {
    throw new CliError('input.scrapeCompany must be a boolean.');
  }
}

async function readInput(inputPath) {
  let text;
  try {
    text = await readFile(inputPath, 'utf8');
  } catch (error) {
    throw new CliError(`Cannot read input file ${inputPath}: ${error.message}`);
  }

  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw new CliError(`Input file ${inputPath} is not valid JSON: ${error.message}`);
  }
  validateInput(input);
  return input;
}

async function probeWritableDirectory(directory) {
  let directoryStat;
  try {
    directoryStat = await stat(directory);
  } catch (error) {
    throw new CliError(`Cannot use output directory ${directory}: ${error.message}`);
  }
  if (!directoryStat.isDirectory()) {
    throw new CliError(`Output parent is not a directory: ${directory}`);
  }

  try {
    await access(directory, 0o2 | 0o1);
  } catch (error) {
    throw new CliError(`Output directory is not writable ${directory}: ${error.message}`);
  }

  const probePath = path.join(
    directory,
    `.meka-jobs-write-check-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(probePath, 'wx', 0o600);
  } catch (error) {
    throw new CliError(`Output directory is not writable ${directory}: ${error.message}`);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(probePath).catch(() => {});
  }
}

async function outputExists(outputPath) {
  try {
    const outputStat = await lstat(outputPath);
    if (outputStat.isDirectory()) {
      throw new CliError(`Output path is a directory: ${outputPath}`);
    }
    return true;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error.code === 'ENOENT') return false;
    throw new CliError(`Cannot inspect output path ${outputPath}: ${error.message}`);
  }
}

async function prepareOutput({
  inputPath,
  outputPath,
  overwrite,
  interactive,
  stdin,
  stdout,
}) {
  if (inputPath === outputPath) {
    throw new CliError('Input and output paths must be different.');
  }

  await probeWritableDirectory(path.dirname(outputPath));
  const exists = await outputExists(outputPath);
  if (!exists) return { overwriteOutput: overwrite };
  if (overwrite) return { overwriteOutput: true };

  if (!interactive) {
    throw new CliError(
      `${outputPath} already exists. Choose another --output or pass --overwrite. `
      + '--yes does not authorize replacing an existing output file.',
    );
  }

  const replace = await askYesNo(
    `Output exists: ${outputPath}\nReplace it only after a successful run? [y/N] `,
    { stdin, stdout },
  );
  if (!replace) {
    throw new CliError('Cancelled; the existing output file was not changed.');
  }
  return { overwriteOutput: true };
}

function printRunPlan({ input, inputPath, outputPath, stdout }) {
  stdout.write([
    'MEKA LinkedIn Jobs',
    '',
    `Input: ${inputPath}`,
    `Output after success: ${outputPath}`,
    'Apify Actor: meka.im~linkedin-jobs-scraper',
    `Requested results: up to ${input.count}`,
    `Hard maximum Actor charge: USD ${maximumChargeUsd}`,
    'Result scope: public LinkedIn job posts only',
    '',
  ].join('\n'));
}

export function formatLocalN8nSuccess(result) {
  return [
    `n8n is ready at ${result.url}`,
    'The bundled LinkedIn Jobs workflow is pre-imported.',
    'If this is the first run, open the URL and complete n8n owner account setup in your browser.',
    'Google Sheets and Apify credentials still need to be connected inside n8n.',
    'No workflow schedule was activated by this command.',
    '',
    `Stop:  docker stop ${result.containerName}`,
    `Start: docker start ${result.containerName}`,
    `Persistent data: Docker volume ${result.volumeName}`,
    '',
  ].join('\n');
}

function printLocalN8nSuccess(result, stdout) {
  stdout.write(formatLocalN8nSuccess(result));
}

async function confirmRun({ yes, interactive, stdin, stdout }) {
  if (yes) {
    stdout.write('Apify request and USD 0.05 hard charge cap accepted by --yes.\n');
    return;
  }
  if (!interactive) {
    throw new CliError(
      'Non-interactive runs require --yes after reviewing the Apify request and charge cap.',
    );
  }
  const accepted = await askYesNo(
    'Call the Apify Actor now? This may charge up to USD 0.05. [y/N] ',
    { stdin, stdout },
  );
  if (!accepted) throw new CliError('Cancelled; no Apify request was made.');
}

async function writeJobsAtomically(outputPath, jobs, { overwrite }) {
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}-${randomUUID()}.tmp`,
  );
  const content = `${JSON.stringify(jobs, null, 2)}\n`;
  let handle;
  let committed = false;
  let temporaryExists = false;

  try {
    handle = await open(temporaryPath, 'wx');
    temporaryExists = true;
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    if (overwrite) {
      await rename(temporaryPath, outputPath);
      temporaryExists = false;
    } else {
      // Hard-linking commits a complete file without ever replacing an existing output.
      await link(temporaryPath, outputPath);
      committed = true;
      await unlink(temporaryPath).catch(() => {});
    }
    committed = true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporaryExists && !committed) await unlink(temporaryPath).catch(() => {});
  }
}

export function redactSecrets(value, token = '') {
  let message = String(value ?? 'Unknown error');
  const variants = new Set();
  if (token) {
    variants.add(token);
    variants.add(encodeURIComponent(token));
    variants.add(new URLSearchParams({ token }).toString().slice('token='.length));
  }
  for (const variant of variants) {
    if (variant) message = message.split(variant).join('[REDACTED]');
  }
  return message
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s,;"'}]+/giu, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED]');
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  cwd = process.cwd(),
  nodeVersion = process.versions.node,
} = {}) {
  let token = typeof env.APIFY_TOKEN === 'string' ? env.APIFY_TOKEN.trim() : '';

  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(options.command === 'n8n' ? n8nHelpText : helpText);
      return 0;
    }
    if (options.command === 'n8n') {
      assertSupportedNodeVersion(nodeVersion);
      const port = options.port ?? N8N_DEFAULT_PORT;
      stdout.write(
        `Starting local n8n from ${N8N_IMAGE} on 127.0.0.1:${port}. `
        + 'Docker may need time to download the image.\n',
      );
      const result = await startLocalN8n({
        port,
      });
      printLocalN8nSuccess(result, stdout);
      return 0;
    }
    if (options.check) {
      return checkRuntime({ version: nodeVersion, token, stdout });
    }
    assertSupportedNodeVersion(nodeVersion);

    const inputPath = path.resolve(cwd, options.input ?? defaultInputPath);
    const outputPath = path.resolve(cwd, options.output ?? defaultOutputName);
    const interactive = isInteractive(stdin, stdout);
    const input = await readInput(inputPath);

    const { overwriteOutput } = await prepareOutput({
      inputPath,
      outputPath,
      overwrite: options.overwrite,
      interactive,
      stdin,
      stdout,
    });

    printRunPlan({ input, inputPath, outputPath, stdout });
    await confirmRun({
      yes: options.yes,
      interactive,
      stdin,
      stdout,
    });

    if (!token) {
      if (!interactive) {
        throw new CliError(
          'APIFY_TOKEN is not configured. Set it in the environment for non-interactive use.',
        );
      }
      token = await readHiddenToken({ stdin, stdout });
    }

    const result = await runLinkedInJobs({ token, input });
    try {
      await writeJobsAtomically(outputPath, result.jobs, {
        overwrite: overwriteOutput,
      });
    } catch (error) {
      throw new CliError(
        `Actor run ${result.runId} succeeded, but writing ${outputPath} failed: ${error.message}`,
      );
    }

    stdout.write(
      `Actor run ${result.runId} succeeded with ${result.jobs.length} job(s); `
      + `wrote ${outputPath}\n`,
    );
    stdout.write(`Run summary: ${JSON.stringify(result.summary)}\n`);
    if (result.summary.coverage === 'partial') {
      stderr.write(
        'Warning: the Actor run was partial; inspect failedJobDetails, '
        + 'failedCompanies, and stoppedByBudget in the summary.\n',
      );
    }
    return 0;
  } catch (error) {
    const message = redactSecrets(error?.message ?? error, token);
    stderr.write(`Error: ${message}\n`);
    return Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await runCli();
}
