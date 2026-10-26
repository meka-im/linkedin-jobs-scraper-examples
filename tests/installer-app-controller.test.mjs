import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginWorkspaceConnection,
  claimInstallSubmit,
  releaseInstallSubmit,
} from '../installer/lib/app-controller.js';

test('app workspace boundary passes one canonical origin string into OAuth', async () => {
  const calls = [];
  const storage = {};
  const result = await beginWorkspaceConnection({
    workspaceInput: 'https://meka-test.app.n8n.cloud',
    redirectUri: 'http://127.0.0.1:4173/',
    storage,
    async beginOAuth(options) {
      calls.push(options);
      return { authorizationUrl: 'https://meka-test.app.n8n.cloud/mcp-oauth/authorize' };
    },
  });

  assert.equal(result.workspace.origin, 'https://meka-test.app.n8n.cloud');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspace, 'https://meka-test.app.n8n.cloud');
  assert.equal(typeof calls[0].workspace, 'string');
  assert.equal(calls[0].storage, storage);
  assert.equal(calls[0].redirectUri, 'http://127.0.0.1:4173/');
});

test('app workspace boundary rejects invalid input before OAuth', async () => {
  let called = false;
  await assert.rejects(beginWorkspaceConnection({
    workspaceInput: 'https://attacker.example',
    redirectUri: 'http://127.0.0.1:4173/',
    storage: {},
    async beginOAuth() {
      called = true;
    },
  }), { code: 'WORKSPACE_INVALID' });
  assert.equal(called, false);
});

test('install submit claim is synchronous and permits only one in-flight request', () => {
  const state = { createAttempted: false };
  const first = claimInstallSubmit(state);
  const second = claimInstallSubmit(state);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'in-flight');

  releaseInstallSubmit(state);
  assert.equal(claimInstallSubmit(state).allowed, true);
  releaseInstallSubmit(state);

  state.createAttempted = true;
  const existing = claimInstallSubmit(state);
  assert.equal(existing.allowed, false);
  assert.equal(existing.reason, 'create-attempted');
});
