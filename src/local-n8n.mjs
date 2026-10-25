import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkflowPath = path.join(
  path.resolve(here, '..'),
  'n8n',
  'linkedin-jobs-to-google-sheets.json',
);

export const N8N_IMAGE = 'docker.n8n.io/n8nio/n8n:2.44.6';
export const N8N_CONTAINER_NAME = 'meka-linkedin-jobs-n8n';
export const N8N_VOLUME_NAME = 'meka-linkedin-jobs-n8n-data';
export const N8N_DATA_DIRECTORY = '/home/node/.n8n';
export const N8N_BOOTSTRAP_PATH = '/tmp/meka-bootstrap-workflow.json';
export const N8N_MARKER_PATH = '/home/node/.n8n/.meka-workflow-import-v1';
export const N8N_DEFAULT_PORT = 5678;
export const N8N_READINESS_TIMEOUT_MS = 180_000;

const managedLabel = 'meka.managed';
const resourceLabel = 'meka.resource';
const roleLabel = 'meka.role';
const workflowHashLabel = 'meka.workflow-sha256';
const resourceId = 'linkedin-jobs-scraper-examples';

export class LocalN8nError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalN8nError';
  }
}

export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new LocalN8nError('Port must be an integer from 1 to 65535.');
  }
  return port;
}

function resourceLabels(role, workflowHash) {
  return {
    [managedLabel]: 'true',
    [resourceLabel]: resourceId,
    [roleLabel]: role,
    [workflowHashLabel]: workflowHash,
  };
}

function labelArgs(labels) {
  return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

export function buildStartupScript(workflowHash) {
  if (!/^[0-9a-f]{64}$/u.test(workflowHash)) {
    throw new LocalN8nError('Workflow hash must be a lowercase SHA-256 digest.');
  }
  return [
    'set -eu',
    `marker=${N8N_MARKER_PATH}`,
    `baseline='${workflowHash}'`,
    'if [ -e "$marker" ]; then',
    '  stored="$(cat "$marker" 2>/dev/null || true)"',
    '  if [ "$stored" != "$baseline" ]; then',
    '    echo "MEKA workflow baseline changed; refusing automatic re-import." >&2',
    '    echo "Use an explicit migration before starting this n8n data volume." >&2',
    '    exit 78',
    '  fi',
    'else',
    `  n8n import:workflow --input=${N8N_BOOTSTRAP_PATH}`,
    '  printf \'%s\\n\' "$baseline" > "$marker"',
    'fi',
    'exec n8n start',
  ].join('\n');
}

export function spawnFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function dockerResult(runFile, args) {
  try {
    return await runFile('docker', args, { shell: false });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new LocalN8nError(
        'Docker CLI was not found. Install Docker Desktop or Docker Engine, then retry.',
      );
    }
    throw new LocalN8nError(`Could not run Docker: ${error.message}`);
  }
}

async function requireDocker(runFile) {
  const result = await dockerResult(runFile, ['info', '--format', '{{.ServerVersion}}']);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new LocalN8nError(
      `Docker daemon is unavailable. Start Docker and retry. Docker reported: ${detail}`,
    );
  }
}

async function inspectResource(runFile, type, name, missingPattern) {
  const result = await dockerResult(runFile, ['inspect', `--type=${type}`, name]);
  if (result.code !== 0) {
    if (missingPattern.test(result.stderr)) return null;
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new LocalN8nError(`Could not inspect Docker ${type} ${name}: ${detail}`);
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new LocalN8nError(`Docker returned invalid JSON while inspecting ${type} ${name}.`);
  }
  if (Array.isArray(payload) && payload.length === 0) return null;
  if (!Array.isArray(payload) || payload.length !== 1 || !payload[0] || typeof payload[0] !== 'object') {
    throw new LocalN8nError(`Docker returned an invalid ${type} inspection for ${name}.`);
  }
  return payload[0];
}

function labelsFor(resource, type) {
  if (type === 'container') return resource.Config?.Labels ?? {};
  return resource.Labels ?? {};
}

function assertOwnedResource(resource, type, role, workflowHash) {
  const name = type === 'container' ? N8N_CONTAINER_NAME : N8N_VOLUME_NAME;
  const labels = labelsFor(resource, type);
  if (labels[managedLabel] !== 'true' || labels[resourceLabel] !== resourceId) {
    throw new LocalN8nError(
      `Docker ${type} ${name} already exists but is not managed by MEKA. `
      + 'Nothing was stopped, deleted, or changed.',
    );
  }
  if (labels[roleLabel] !== role) {
    throw new LocalN8nError(
      `Docker ${type} ${name} has unexpected MEKA role metadata. `
      + 'Nothing was stopped, deleted, or changed.',
    );
  }
  if (labels[workflowHashLabel] !== workflowHash) {
    throw new LocalN8nError(
      `Docker ${type} ${name} uses a different workflow baseline. `
      + 'This command will not re-import or replace data automatically; use an explicit '
      + 'migration, then retry.',
    );
  }
}

function assertContainerShape(container) {
  if (container.Config?.Image !== N8N_IMAGE) {
    throw new LocalN8nError(
      `MEKA container ${N8N_CONTAINER_NAME} does not use ${N8N_IMAGE}. `
      + 'It was not started or replaced.',
    );
  }
  if (container.Config?.User !== 'node') {
    throw new LocalN8nError(
      `MEKA container ${N8N_CONTAINER_NAME} is not configured to run as the node user. `
      + 'It was not started or replaced.',
    );
  }

  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  const volumeMounts = mounts.filter((mount) => mount?.Type === 'volume');
  if (
    volumeMounts.length !== 1
    || volumeMounts[0].Destination !== N8N_DATA_DIRECTORY
    || volumeMounts[0].Name !== N8N_VOLUME_NAME
  ) {
    throw new LocalN8nError(
      `MEKA container ${N8N_CONTAINER_NAME} is not mounted to its dedicated data volume. `
      + 'It was not started or replaced.',
    );
  }
  if (mounts.some((mount) => mount?.Type === 'bind')) {
    throw new LocalN8nError(
      `MEKA container ${N8N_CONTAINER_NAME} contains a temporary host bind mount. `
      + 'It was not started or replaced; use an explicit migration to the container-copy '
      + 'bootstrap layout.',
    );
  }
}

function assertPublishedPort(container, port) {
  const configuredBindings = container.HostConfig?.PortBindings ?? {};
  const publishedKeys = Object.keys(configuredBindings).filter(
    (key) => Array.isArray(configuredBindings[key]) && configuredBindings[key].length > 0,
  );
  const binding = configuredBindings['5678/tcp'];
  if (
    publishedKeys.length !== 1
    || publishedKeys[0] !== '5678/tcp'
    || !Array.isArray(binding)
    || binding.length !== 1
    || binding[0]?.HostIp !== '127.0.0.1'
    || String(binding[0]?.HostPort) !== String(port)
  ) {
    throw portMismatchError(port);
  }

  if (container.State?.Running === true) {
    const actual = container.NetworkSettings?.Ports?.['5678/tcp'];
    if (
      !Array.isArray(actual)
      || actual.length !== 1
      || actual[0]?.HostIp !== '127.0.0.1'
      || String(actual[0]?.HostPort) !== String(port)
    ) {
      throw portMismatchError(port);
    }
  }
}

function portMismatchError(port) {
  return new LocalN8nError(
    `MEKA container ${N8N_CONTAINER_NAME} does not map 127.0.0.1:${port} `
    + 'to container port 5678. '
    + 'It was not started or changed. Pass the port already assigned to this container.',
  );
}

async function ensureVolume(runFile, workflowHash, { createIfMissing }) {
  let volume = await inspectResource(
    runFile,
    'volume',
    N8N_VOLUME_NAME,
    /no such (?:volume|object)/iu,
  );
  if (volume) {
    assertOwnedResource(volume, 'volume', 'data', workflowHash);
    return { volume, created: false };
  }
  if (!createIfMissing) {
    throw new LocalN8nError(
      `MEKA container ${N8N_CONTAINER_NAME} references missing volume ${N8N_VOLUME_NAME}. `
      + 'Nothing was started or changed.',
    );
  }

  const labels = resourceLabels('data', workflowHash);
  const result = await dockerResult(runFile, [
    'volume',
    'create',
    ...labelArgs(labels),
    N8N_VOLUME_NAME,
  ]);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new LocalN8nError(`Docker could not create ${N8N_VOLUME_NAME}: ${detail}`);
  }

  volume = await inspectResource(
    runFile,
    'volume',
    N8N_VOLUME_NAME,
    /no such (?:volume|object)/iu,
  );
  if (!volume) {
    throw new LocalN8nError(`Docker did not create volume ${N8N_VOLUME_NAME}.`);
  }
  assertOwnedResource(volume, 'volume', 'data', workflowHash);
  return { volume, created: true };
}

function newContainerArguments({ port, workflowHash }) {
  const labels = resourceLabels('n8n', workflowHash);
  const script = buildStartupScript(workflowHash);
  return [
    'create',
    '--name',
    N8N_CONTAINER_NAME,
    ...labelArgs(labels),
    '--publish',
    `127.0.0.1:${port}:5678`,
    '--volume',
    `${N8N_VOLUME_NAME}:${N8N_DATA_DIRECTORY}`,
    '--user',
    'node',
    '--env',
    'HOME=/home/node',
    '--env',
    'N8N_PORT=5678',
    '--env',
    'N8N_HOST=localhost',
    '--env',
    'N8N_PROTOCOL=http',
    '--env',
    'N8N_SECURE_COOKIE=false',
    '--entrypoint',
    '/bin/sh',
    N8N_IMAGE,
    '-c',
    script,
  ];
}

async function copyWorkflowIntoContainer(runFile, workflowPath) {
  const result = await dockerResult(runFile, [
    'cp',
    workflowPath,
    `${N8N_CONTAINER_NAME}:${N8N_BOOTSTRAP_PATH}`,
  ]);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.code}`;
    throw new LocalN8nError(
      `Docker could not copy the bundled workflow into ${N8N_CONTAINER_NAME}: ${detail}. `
      + `The container was not started; data in ${N8N_VOLUME_NAME} was retained. `
      + `Inspect logs with: docker logs --tail 200 ${N8N_CONTAINER_NAME}`,
    );
  }
}

async function waitForReadiness({
  port,
  fetchImpl,
  sleepFn,
  nowFn,
  timeoutMs,
  pollIntervalMs,
}) {
  const url = `http://127.0.0.1:${port}/healthz/readiness`;
  const deadline = nowFn() + timeoutMs;
  let lastStatus = 'no response';

  while (nowFn() < deadline) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, timeoutMs))),
      });
      lastStatus = `HTTP ${response.status}`;
      await response.body?.cancel();
      if (response.ok) return;
    } catch (error) {
      lastStatus = error?.name ? `${error.name}: ${error.message}` : String(error);
    }

    const remaining = deadline - nowFn();
    if (remaining <= 0) break;
    await sleepFn(Math.min(pollIntervalMs, remaining));
  }

  throw new LocalN8nError(
    `n8n did not become ready within ${Math.round(timeoutMs / 1_000)} seconds `
    + `(${lastStatus}). Container ${N8N_CONTAINER_NAME} and volume ${N8N_VOLUME_NAME} `
    + 'were retained. Inspect logs with: '
    + `docker logs --tail 200 ${N8N_CONTAINER_NAME}`,
  );
}

export async function startLocalN8n({
  port = N8N_DEFAULT_PORT,
  workflowPath = defaultWorkflowPath,
  runFile = spawnFile,
  fetchImpl = globalThis.fetch,
  sleepFn = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  nowFn = Date.now,
  readinessTimeoutMs = N8N_READINESS_TIMEOUT_MS,
  pollIntervalMs = 2_000,
} = {}) {
  const checkedPort = validatePort(port);
  if (typeof runFile !== 'function') throw new LocalN8nError('Docker runner is unavailable.');
  if (typeof fetchImpl !== 'function') throw new LocalN8nError('Runtime fetch is unavailable.');

  const resolvedWorkflowPath = path.resolve(workflowPath);
  let workflowBytes;
  try {
    workflowBytes = await readFile(resolvedWorkflowPath);
  } catch (error) {
    throw new LocalN8nError(
      `Cannot read bundled n8n workflow ${resolvedWorkflowPath}: ${error.message}`,
    );
  }
  const workflowHash = createHash('sha256').update(workflowBytes).digest('hex');

  await requireDocker(runFile);

  let container = await inspectResource(
    runFile,
    'container',
    N8N_CONTAINER_NAME,
    /no such (?:container|object)/iu,
  );
  if (container) {
    assertOwnedResource(container, 'container', 'n8n', workflowHash);
    assertContainerShape(container);
    assertPublishedPort(container, checkedPort);
  }
  const { created: volumeCreated } = await ensureVolume(
    runFile,
    workflowHash,
    { createIfMissing: !container },
  );
  let started = false;

  if (container) {
    if (container.State?.Running !== true) {
      await copyWorkflowIntoContainer(runFile, resolvedWorkflowPath);
      const startResult = await dockerResult(runFile, ['start', N8N_CONTAINER_NAME]);
      if (startResult.code !== 0) {
        const detail = startResult.stderr.trim() || `exit code ${startResult.code}`;
        throw new LocalN8nError(
          `Docker could not start ${N8N_CONTAINER_NAME}: ${detail}. `
          + `Data remains in ${N8N_VOLUME_NAME}. Inspect logs with: `
          + `docker logs --tail 200 ${N8N_CONTAINER_NAME}`,
        );
      }
      started = true;
    }
  } else {
    const createResult = await dockerResult(
      runFile,
      newContainerArguments({
        port: checkedPort,
        workflowHash,
      }),
    );
    if (createResult.code !== 0) {
      const detail = createResult.stderr.trim() || `exit code ${createResult.code}`;
      throw new LocalN8nError(
        `Docker could not create n8n: ${detail}. `
        + `Any data in ${N8N_VOLUME_NAME} was retained. `
        + `Inspect logs with: docker logs --tail 200 ${N8N_CONTAINER_NAME}`,
      );
    }

    await copyWorkflowIntoContainer(runFile, resolvedWorkflowPath);
    const startResult = await dockerResult(runFile, ['start', N8N_CONTAINER_NAME]);
    if (startResult.code !== 0) {
      const detail = startResult.stderr.trim() || `exit code ${startResult.code}`;
      throw new LocalN8nError(
        `Docker could not start ${N8N_CONTAINER_NAME}: ${detail}. `
        + `The container and data in ${N8N_VOLUME_NAME} were retained. Inspect logs with: `
        + `docker logs --tail 200 ${N8N_CONTAINER_NAME}`,
      );
    }
    started = true;
  }

  await waitForReadiness({
    port: checkedPort,
    fetchImpl,
    sleepFn,
    nowFn,
    timeoutMs: readinessTimeoutMs,
    pollIntervalMs,
  });

  return {
    url: `http://localhost:${checkedPort}`,
    containerName: N8N_CONTAINER_NAME,
    volumeName: N8N_VOLUME_NAME,
    workflowHash,
    started,
    running: true,
    volumeCreated,
  };
}
