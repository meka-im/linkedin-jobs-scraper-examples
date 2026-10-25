import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  N8N_BOOTSTRAP_PATH,
  N8N_CONTAINER_NAME,
  N8N_DATA_DIRECTORY,
  N8N_IMAGE,
  N8N_MARKER_PATH,
  N8N_READINESS_TIMEOUT_MS,
  N8N_VOLUME_NAME,
  buildStartupScript,
  startLocalN8n,
  validatePort,
} from '../src/local-n8n.mjs';

const workflowBody = '{"name":"MEKA local n8n test workflow"}\n';
const workflowHash = createHash('sha256').update(workflowBody).digest('hex');

function ok(stdout = '') {
  return { code: 0, signal: null, stdout, stderr: '' };
}

function failed(stderr, code = 1) {
  return { code, signal: null, stdout: '', stderr };
}

function labels(role, hash = workflowHash) {
  return {
    'meka.managed': 'true',
    'meka.resource': 'linkedin-jobs-scraper-examples',
    'meka.role': role,
    'meka.workflow-sha256': hash,
  };
}

function volumeFixture(overrides = {}) {
  return {
    Name: N8N_VOLUME_NAME,
    Labels: labels('data'),
    ...overrides,
  };
}

function containerFixture({
  running = true,
  port = 5678,
  containerLabels = labels('n8n'),
  image = N8N_IMAGE,
  user = 'node',
  hostIp = '127.0.0.1',
} = {}) {
  const binding = [{ HostIp: hostIp, HostPort: String(port) }];
  return {
    Config: {
      Image: image,
      User: user,
      Labels: containerLabels,
    },
    State: {
      Running: running,
      Status: running ? 'running' : 'exited',
    },
    HostConfig: {
      PortBindings: {
        '5678/tcp': binding,
      },
    },
    NetworkSettings: {
      Ports: {
        '5678/tcp': binding,
      },
    },
    Mounts: [
      {
        Type: 'volume',
        Name: N8N_VOLUME_NAME,
        Destination: N8N_DATA_DIRECTORY,
        RW: true,
      },
    ],
  };
}

function dockerHarness({
  container = null,
  volume = null,
  infoResult = ok('29.1.3\n'),
  startResult = ok(`${N8N_CONTAINER_NAME}\n`),
  createResult = ok('container-id\n'),
  copyResult = ok(''),
} = {}) {
  const calls = [];
  let createdVolume = null;

  async function runFile(command, args, options) {
    calls.push({ command, args, options });
    if (command !== 'docker') throw new Error(`unexpected command ${command}`);
    assert.equal(options.shell, false);

    if (args[0] === 'info') return infoResult;
    if (args[0] === 'inspect') {
      const typeArgument = args.find((argument) => argument.startsWith('--type='));
      const type = typeArgument?.slice('--type='.length);
      const name = args.at(-1);
      if (type === 'container') {
        if (!container) return failed(`Error: No such container: ${name}`);
        return ok(JSON.stringify([container]));
      }
      if (type === 'volume') {
        const found = createdVolume ?? volume;
        if (!found) return failed(`Error response from daemon: no such volume: ${name}`);
        return ok(JSON.stringify([found]));
      }
      throw new Error(`unexpected inspect type ${type}`);
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      createdVolume = volumeFixture();
      return ok(`${N8N_VOLUME_NAME}\n`);
    }
    if (args[0] === 'create') return createResult;
    if (args[0] === 'cp') return copyResult;
    if (args[0] === 'start') return startResult;
    throw new Error(`unexpected docker command ${args.join(' ')}`);
  }

  return { calls, runFile };
}

function healthyFetch(calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return new Response('', { status: 200 });
  };
}

async function withWorkflow(callback) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'meka-local-n8n-'));
  const workflowPath = path.join(temporary, 'workflow.json');
  try {
    await writeFile(workflowPath, workflowBody);
    return await callback({ temporary, workflowPath });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test('creates and copies the official image with isolated resources and one-time import bootstrap', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const docker = dockerHarness();
    const readinessCalls = [];
    const result = await startLocalN8n({
      workflowPath,
      runFile: docker.runFile,
      fetchImpl: healthyFetch(readinessCalls),
      sleepFn: async () => {},
    });

    assert.equal(result.url, 'http://localhost:5678');
    assert.equal(result.started, true);
    assert.equal(result.volumeCreated, true);
    assert.deepEqual(
      readinessCalls.map(({ url }) => url),
      ['http://127.0.0.1:5678/healthz/readiness'],
    );

    const createCall = docker.calls.find(({ args }) => args[0] === 'create');
    assert.ok(createCall);
    const { args } = createCall;
    assert.equal(args.includes('--detach'), false);
    assert.equal(args.includes(N8N_IMAGE), true);
    assert.equal(args.includes('docker.n8n.io/n8nio/n8n:stable'), false);

    const publishIndex = args.indexOf('--publish');
    assert.equal(args[publishIndex + 1], '127.0.0.1:5678:5678');
    assert.equal(args.filter((argument) => argument === '--publish').length, 1);

    const userIndex = args.indexOf('--user');
    assert.equal(args[userIndex + 1], 'node');
    const volumeIndex = args.indexOf('--volume');
    assert.equal(args[volumeIndex + 1], `${N8N_VOLUME_NAME}:${N8N_DATA_DIRECTORY}`);
    assert.equal(args.includes('--mount'), false);
    assert.equal(args.some((argument) => argument.includes(workflowPath)), false);

    assert.equal(args.includes('meka.managed=true'), true);
    assert.equal(args.includes(`meka.workflow-sha256=${workflowHash}`), true);
    assert.equal(args.includes('N8N_SECURE_COOKIE=false'), true);

    const volumeCreate = docker.calls.find(
      ({ args }) => args[0] === 'volume' && args[1] === 'create',
    );
    assert.ok(volumeCreate);
    assert.equal(volumeCreate.args.at(-1), N8N_VOLUME_NAME);
    assert.equal(volumeCreate.args.includes('meka.managed=true'), true);
    assert.equal(volumeCreate.args.includes(`meka.workflow-sha256=${workflowHash}`), true);

    const copyCall = docker.calls.find(({ args }) => args[0] === 'cp');
    assert.ok(copyCall);
    assert.deepEqual(
      copyCall.args,
      ['cp', workflowPath, `${N8N_CONTAINER_NAME}:${N8N_BOOTSTRAP_PATH}`],
    );
    const createIndex = docker.calls.findIndex(({ args }) => args[0] === 'create');
    const copyIndex = docker.calls.findIndex(({ args }) => args[0] === 'cp');
    const startIndex = docker.calls.findIndex(({ args }) => args[0] === 'start');
    assert.ok(createIndex < copyIndex && copyIndex < startIndex);

    const script = args.at(-1);
    assert.equal((script.match(/n8n import:workflow/gu) ?? []).length, 1);
    assert.match(script, new RegExp(N8N_MARKER_PATH.replaceAll('/', '\\/')));
    assert.match(script, new RegExp(workflowHash));
    assert.match(script, /exec n8n start/);
    assert.doesNotMatch(script, /5678/);
    assert.doesNotMatch(script, new RegExp(workflowPath));
    assert.doesNotMatch(script, /APIFY_TOKEN|GOOGLE|credential/iu);
    assert.doesNotMatch(script, /activate/iu);
  });
});

test('an owned running container is reused only when its loopback port matches', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const docker = dockerHarness({
      container: containerFixture({ running: true }),
      volume: volumeFixture(),
    });
    const result = await startLocalN8n({
      workflowPath,
      runFile: docker.runFile,
      fetchImpl: healthyFetch(),
      sleepFn: async () => {},
    });

    assert.equal(result.started, false);
    assert.equal(
      docker.calls.some(
        ({ args }) => ['start', 'create', 'cp'].includes(args[0]),
      ),
      false,
    );
  });
});

test('an owned stopped container keeps its volume and uses docker start', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const docker = dockerHarness({
      container: containerFixture({ running: false }),
      volume: volumeFixture(),
    });
    const result = await startLocalN8n({
      workflowPath,
      runFile: docker.runFile,
      fetchImpl: healthyFetch(),
      sleepFn: async () => {},
    });

    assert.equal(result.started, true);
    assert.equal(
      docker.calls.filter(({ args }) => args[0] === 'start' && args[1] === N8N_CONTAINER_NAME)
        .length,
      1,
    );
    assert.equal(
      docker.calls.filter(({ args }) => args[0] === 'cp'
        && args[1] === workflowPath
        && args[2] === `${N8N_CONTAINER_NAME}:${N8N_BOOTSTRAP_PATH}`).length,
      1,
    );
    assert.equal(docker.calls.some(({ args }) => args[0] === 'create'), false);
    assert.equal(docker.calls.some(({ args }) => args[0] === 'volume' && args[1] === 'create'), false);
  });
});

test('a stopped container restarts after the original npx cache path disappears', async () => {
  await withWorkflow(async ({ temporary, workflowPath }) => {
    const vanishedCachePath = path.join(temporary, 'removed-npx-cache', 'workflow.json');
    const stoppedContainer = containerFixture({ running: false });
    assert.equal(
      stoppedContainer.Mounts.some(({ Source }) => Source === vanishedCachePath),
      false,
    );
    const docker = dockerHarness({
      container: stoppedContainer,
      volume: volumeFixture(),
    });

    await startLocalN8n({
      workflowPath,
      runFile: docker.runFile,
      fetchImpl: healthyFetch(),
      sleepFn: async () => {},
    });

    assert.equal(
      docker.calls.some(({ args }) => args[0] === 'cp'
        && args[1] === workflowPath
        && args[2] === `${N8N_CONTAINER_NAME}:${N8N_BOOTSTRAP_PATH}`),
      true,
    );
    assert.equal(docker.calls.some(({ args }) => args[0] === 'start'), true);
    assert.equal(docker.calls.some(({ args }) => args[0] === 'create'), false);

    const script = buildStartupScript(workflowHash);
    const markerGuard = script.indexOf('if [ -e "$marker" ]');
    const importCommand = script.indexOf('n8n import:workflow');
    const startCommand = script.indexOf('exec n8n start');
    assert.ok(markerGuard >= 0 && markerGuard < importCommand && importCommand < startCommand);
    assert.equal((script.match(/n8n import:workflow/gu) ?? []).length, 1);
  });
});

test('a legacy container with a host bootstrap bind is not started', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const legacyContainer = containerFixture({ running: false });
    legacyContainer.Mounts.push({
      Type: 'bind',
      Source: '/old/npx/cache/workflow.json',
      Destination: N8N_BOOTSTRAP_PATH,
      RW: false,
    });
    const docker = dockerHarness({
      container: legacyContainer,
      volume: volumeFixture(),
    });

    await assert.rejects(
      startLocalN8n({
        workflowPath,
        runFile: docker.runFile,
        fetchImpl: healthyFetch(),
      }),
      /temporary host bind mount/,
    );
    assert.equal(
      docker.calls.some(({ args }) => ['cp', 'start'].includes(args[0])),
      false,
    );
  });
});

test('a same-name container not owned by MEKA is never taken over', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const docker = dockerHarness({
      container: containerFixture({
        containerLabels: { 'com.example.user-resource': 'true' },
      }),
    });

    await assert.rejects(
      startLocalN8n({
        workflowPath,
        runFile: docker.runFile,
        fetchImpl: healthyFetch(),
      }),
      /not managed by MEKA/,
    );
    assert.equal(
      docker.calls.some(({ args }) => ['start', 'create', 'cp'].includes(args[0])),
      false,
    );
    assert.equal(
      docker.calls.some(({ args }) => args[0] === 'volume' && args[1] === 'create'),
      false,
    );
  });
});

test('a same-name volume not owned by MEKA blocks container creation', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const docker = dockerHarness({
      volume: volumeFixture({ Labels: { 'com.example.user-resource': 'true' } }),
    });

    await assert.rejects(
      startLocalN8n({
        workflowPath,
        runFile: docker.runFile,
        fetchImpl: healthyFetch(),
      }),
      /not managed by MEKA/,
    );
    assert.equal(docker.calls.some(({ args }) => args[0] === 'create'), false);
    assert.equal(docker.calls.some(({ args }) => args[0] === 'cp'), false);
  });
});

test('port or workflow baseline mismatches do not start or replace MEKA resources', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const portMismatch = dockerHarness({
      container: containerFixture({
        running: false,
        port: 6000,
      }),
      volume: volumeFixture(),
    });
    await assert.rejects(
      startLocalN8n({
        workflowPath,
        port: 5678,
        runFile: portMismatch.runFile,
        fetchImpl: healthyFetch(),
      }),
      /does not map 127\.0\.0\.1:5678 to container port 5678/,
    );
    assert.equal(
      portMismatch.calls.some(({ args }) => ['start', 'cp'].includes(args[0])),
      false,
    );

    const hashMismatch = dockerHarness({
      container: containerFixture({
        running: false,
        containerLabels: labels('n8n', 'a'.repeat(64)),
      }),
      volume: volumeFixture(),
    });
    await assert.rejects(
      startLocalN8n({
        workflowPath,
        runFile: hashMismatch.runFile,
        fetchImpl: healthyFetch(),
      }),
      /different workflow baseline/,
    );
    assert.equal(
      hashMismatch.calls.some(({ args }) => ['start', 'cp'].includes(args[0])),
      false,
    );
  });
});

test('a changed volume baseline blocks startup without deleting or clearing data', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const docker = dockerHarness({
      container: containerFixture({ running: false }),
      volume: volumeFixture({ Labels: labels('data', 'b'.repeat(64)) }),
    });

    await assert.rejects(
      startLocalN8n({
        workflowPath,
        runFile: docker.runFile,
        fetchImpl: healthyFetch(),
      }),
      /different workflow baseline/,
    );
    assert.equal(
      docker.calls.some(({ args }) => ['start', 'cp'].includes(args[0])),
      false,
    );
  });
});

test('Docker daemon failures are clear and do not create resources', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const docker = dockerHarness({
      infoResult: failed('Cannot connect to the Docker daemon'),
    });
    await assert.rejects(
      startLocalN8n({
        workflowPath,
        runFile: docker.runFile,
        fetchImpl: healthyFetch(),
      }),
      /Docker daemon is unavailable/,
    );
    assert.equal(docker.calls.length, 1);
  });
});

test('Docker CLI absence is reported without attempting to create resources', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const calls = [];
    const runFile = async (command, args, options) => {
      calls.push({ command, args, options });
      const error = new Error('spawn docker ENOENT');
      error.code = 'ENOENT';
      throw error;
    };

    await assert.rejects(
      startLocalN8n({
        workflowPath,
        runFile,
        fetchImpl: healthyFetch(),
      }),
      /Docker CLI was not found/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.shell, false);
  });
});

test('readiness is bounded, reports the log command, and retains the volume', async () => {
  await withWorkflow(async ({ workflowPath }) => {
    const docker = dockerHarness({
      container: containerFixture({ running: true }),
      volume: volumeFixture(),
    });
    let clock = 0;
    const fetchImpl = async () => new Response('', { status: 503 });

    await assert.rejects(
      startLocalN8n({
        workflowPath,
        runFile: docker.runFile,
        fetchImpl,
        sleepFn: async () => {},
        nowFn: () => {
          clock += 7;
          return clock;
        },
        readinessTimeoutMs: 10,
        pollIntervalMs: 2,
      }),
      (error) => {
        assert.match(error.message, /did not become ready/);
        assert.match(error.message, /HTTP 503/);
        assert.match(error.message, /were retained/);
        assert.match(error.message, new RegExp(`docker logs --tail 200 ${N8N_CONTAINER_NAME}`));
        return true;
      },
    );
    assert.equal(N8N_READINESS_TIMEOUT_MS, 180_000);
    assert.equal(
      docker.calls.some(({ args }) => ['rm', 'stop', 'volume'].includes(args[0])),
      false,
    );
  });
});

test('the CLI port range is enforced in the local n8n module', () => {
  assert.equal(validatePort(1), 1);
  assert.equal(validatePort(65_535), 65_535);
  assert.throws(() => validatePort(0), /1 to 65535/);
  assert.throws(() => validatePort(65_536), /1 to 65535/);
  assert.throws(() => validatePort('5678.5'), /1 to 65535/);
});
