import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CREDENTIAL_NODE_NAMES,
  credentialNodeCounts,
  renderWorkflowCode,
  validateInstallerSettings,
} from '../installer/lib/workflow-code.js';
import {
  installWorkflow,
  makeInstallationIdentity,
  recoverUnknownInstallation,
} from '../installer/lib/install.js';
import {
  loadInstallRecovery,
  saveInstallRecovery,
} from '../installer/lib/install-recovery.js';
import { createMemorySessionStore } from '../installer/lib/oauth-session.js';
import { createSettingsProof } from '../installer/lib/settings-proof.js';
import { verifyInstalledWorkflow } from '../installer/lib/verify-install.js';
import {
  WORKFLOW_TEMPLATE,
  WORKFLOW_TEMPLATE_SHA256,
} from '../installer/generated/workflow-template.js';
import { WORKFLOW_MANIFEST } from '../installer/generated/workflow-manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = 'https://meka-test.app.n8n.cloud';
const CLOUD_WORKFLOW = JSON.parse(
  await readFile(path.join(root, 'n8n', 'linkedin-jobs-cloud.json'), 'utf8'),
);
const settings = {
  keywords: 'software engineer',
  location: 'London, United Kingdom',
  datePosted: 'pastWeek',
  limit: 10,
  budgetUsd: 0.05,
  scrapeCompany: false,
  spreadsheetTitle: 'LinkedIn jobs',
};
const apify = {
  id: 'apify_credential',
  name: 'Apify managed OAuth',
  type: 'apifyOAuth2Api',
};
const google = {
  id: 'google_credential',
  name: 'Google Sheets OAuth',
  type: 'googleSheetsOAuth2Api',
};

function detailsFor(settingsValue, mutate = () => {}) {
  const nodes = structuredClone(CLOUD_WORKFLOW.nodes).map((node) => {
    delete node.credentials;
    return node;
  });
  const search = nodes.find((node) => node.name === 'Search settings');
  for (const assignment of search.parameters.assignments.assignments) {
    if (Object.hasOwn(settingsValue, assignment.name)) {
      assignment.value = settingsValue[assignment.name];
    }
  }
  const workflow = {
    id: 'workflow-123',
    name: 'MEKA LinkedIn Jobs · ABCD2345',
    active: false,
    nodes,
    connections: structuredClone(CLOUD_WORKFLOW.connections),
    settings: {
      ...CLOUD_WORKFLOW.settings,
      availableInMCP: true,
    },
  };
  mutate(workflow);
  return { workflow };
}

function fakeClient({ validate = { valid: true }, createError = null, details = null } = {}) {
  const calls = [];
  const client = {
    workspaceOrigin: WORKSPACE,
    tools: new Set([
      'list_credentials',
      'validate_workflow',
      'create_workflow_from_code',
      'get_workflow_details',
    ]),
    requireTools(names) {
      const missing = names.filter((name) => !this.tools.has(name));
      if (missing.length) throw new Error(`missing tools: ${missing.join(',')}`);
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'list_credentials') {
        return {
          count: 1,
          data: args.type === 'apifyOAuth2Api' ? [apify] : [google],
        };
      }
      if (name === 'validate_workflow') return validate;
      if (name === 'create_workflow_from_code') {
        if (createError) throw createError;
        return {
          workflowId: 'workflow-123',
          name: args.name,
          nodeCount: 41,
          url: `${WORKSPACE}/workflow/workflow-123`,
        };
      }
      if (name === 'get_workflow_details') {
        return details ?? detailsFor(settings);
      }
      throw new Error(`unexpected tool ${name}`);
    },
  };
  return { client, calls };
}

test('protected Cloud artifact and original Header Auth fingerprints stay unchanged', async () => {
  const cloud = await readFile(path.join(root, 'n8n', 'linkedin-jobs-cloud.json'));
  const header = await readFile(path.join(root, 'n8n', 'linkedin-jobs-to-google-sheets.json'));
  assert.equal(
    createHash('sha256').update(cloud).digest('hex'),
    'fcdb945365562ec97243d353b344ecc67b1a9738c310d15cfe18f130122dd85b',
  );
  assert.equal(
    createHash('sha256').update(header).digest('hex'),
    '8823e9720a601683197fff35a30586343f58632515e1854d7f13cd417f2299ac',
  );
  assert.equal(
    createHash('sha256').update(WORKFLOW_TEMPLATE).digest('hex'),
    WORKFLOW_TEMPLATE_SHA256,
  );
});

test('generated manifest preserves the complete 41-node graph and 14-bind layout', () => {
  assert.equal(WORKFLOW_MANIFEST.nodeCount, 41);
  assert.equal(WORKFLOW_MANIFEST.connectionCount, 39);
  assert.deepEqual(WORKFLOW_MANIFEST.credentialNodeCounts, { apify: 4, google: 10 });
  assert.equal(
    CREDENTIAL_NODE_NAMES.apifyOAuth2Api.length
      + CREDENTIAL_NODE_NAMES.googleSheetsOAuth2Api.length,
    14,
  );
  assert.deepEqual(credentialNodeCounts(WORKFLOW_TEMPLATE), { apify: 4, google: 10 });
});

test('runtime injection escapes user input and preserves all explicit bindings', () => {
  const adversarial = {
    ...settings,
    keywords: "'; globalThis.pwned = true; //\n${process.exit()}",
    location: `London\", "injected": true`,
    spreadsheetTitle: "Jobs ' / \\ 2026",
  };
  const code = renderWorkflowCode({
    template: WORKFLOW_TEMPLATE,
    settings: adversarial,
    apifyCredential: { ...apify, name: "Apify ' quoted" },
    googleCredential: { ...google, name: 'Google " quoted' },
  });
  assert.equal((code.match(/apifyOAuth2Api: newCredential\(/gu) ?? []).length, 4);
  assert.equal((code.match(/googleSheetsOAuth2Api: newCredential\(/gu) ?? []).length, 10);
  assert.equal(code.includes('__MEKA_'), false);
  assert.equal(code.includes('999991'), false);
  assert.equal(code.includes('globalThis.pwned = true;\n'), false);
  assert.ok(code.length < 300_000);
  assert.throws(() => validateInstallerSettings({ ...settings, datePosted: 'tomorrow' }), {
    code: 'SEARCH_SETTINGS_INVALID',
  });
  assert.throws(() => renderWorkflowCode({
    template: WORKFLOW_TEMPLATE,
    settings,
    apifyCredential: { ...apify, id: "../../bad" },
    googleCredential: google,
  }), { code: 'CREDENTIAL_INVALID' });
});

test('successful install validates first, creates once, and verifies graph without credential readback', async () => {
  const { client, calls } = fakeClient();
  const state = {};
  const result = await installWorkflow({
    client,
    template: WORKFLOW_TEMPLATE,
    manifest: WORKFLOW_MANIFEST,
    settings,
    workflowBaseName: 'MEKA LinkedIn Jobs',
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    nonce: 'ABCD2345',
    state,
  });
  assert.equal(result.graphVerified, true);
  assert.equal(result.credentialBindingsSubmitted, 14);
  assert.equal(result.credentialReadbackVisibility, 'not-exposed');
  assert.equal(state.status, 'installed');
  assert.equal(calls.filter(({ name }) => name === 'create_workflow_from_code').length, 1);
  assert.equal(calls.some(({ name }) => /execute|publish|delete|archive/iu.test(name)), false);
  assert.ok(
    calls.findIndex(({ name }) => name === 'validate_workflow')
      < calls.findIndex(({ name }) => name === 'create_workflow_from_code'),
  );
});

test('validation failure blocks create and credential ambiguity blocks all network writes', async () => {
  const upstreamSentinel = 'private-upstream-validation-detail';
  const failed = fakeClient({
    validate: { valid: false, errors: [{ message: upstreamSentinel }] },
  });
  await assert.rejects(installWorkflow({
    client: failed.client,
    template: WORKFLOW_TEMPLATE,
    manifest: WORKFLOW_MANIFEST,
    settings,
    workflowBaseName: 'MEKA LinkedIn Jobs',
    apifyCredentialId: '',
    googleCredentialId: '',
    nonce: 'ABCD2345',
    state: {},
  }), (error) => (
    error.code === 'WORKFLOW_VALIDATION_FAILED'
    && !error.message.includes(upstreamSentinel)
  ));
  assert.equal(failed.calls.some(({ name }) => name === 'create_workflow_from_code'), false);

  const ambiguous = fakeClient();
  const original = ambiguous.client.callTool.bind(ambiguous.client);
  ambiguous.client.callTool = async (name, args) => {
    if (name === 'list_credentials') {
      const data = args.type === 'apifyOAuth2Api'
        ? [apify, { ...apify, id: 'other_apify', name: 'Other Apify' }]
        : [google];
      return {
        count: data.length,
        data,
      };
    }
    return original(name, args);
  };
  await assert.rejects(installWorkflow({
    client: ambiguous.client,
    template: WORKFLOW_TEMPLATE,
    manifest: WORKFLOW_MANIFEST,
    settings,
    workflowBaseName: 'MEKA LinkedIn Jobs',
    apifyCredentialId: '',
    googleCredentialId: '',
    nonce: 'ABCD2345',
    state: {},
  }), { code: 'CREDENTIAL_SELECTION_REQUIRED' });
  assert.equal(ambiguous.calls.some(({ name }) => ['validate_workflow', 'create_workflow_from_code'].includes(name)), false);
});

test('unknown create response is recorded and never retried automatically', async () => {
  const { client, calls } = fakeClient({ createError: new Error('network reset') });
  const state = {};
  await assert.rejects(installWorkflow({
    client,
    template: WORKFLOW_TEMPLATE,
    manifest: WORKFLOW_MANIFEST,
    settings,
    workflowBaseName: 'MEKA LinkedIn Jobs',
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    nonce: 'ABCD2345',
    state,
  }), { code: 'CREATE_RESULT_UNKNOWN' });
  assert.equal(state.createAttempted, true);
  assert.equal(state.status, 'unknown');
  await assert.rejects(installWorkflow({
    client,
    template: WORKFLOW_TEMPLATE,
    manifest: WORKFLOW_MANIFEST,
    settings,
    workflowBaseName: 'MEKA LinkedIn Jobs',
    apifyCredentialId: apify.id,
    googleCredentialId: google.id,
    nonce: 'ABCD2345',
    state,
  }), { code: 'CREATE_RESULT_UNKNOWN' });
  assert.equal(calls.filter(({ name }) => name === 'create_workflow_from_code').length, 1);
});

test('unknown-result recovery searches only the unique marker and never creates a replacement', async () => {
  const identity = makeInstallationIdentity('MEKA LinkedIn Jobs', 'ABCD2345');
  const state = {
    createAttempted: true,
    status: 'unknown',
    identity,
    settings,
    workspaceOrigin: WORKSPACE,
  };
  const { client, calls } = fakeClient();
  client.tools.add('search_workflows');
  const baseCall = client.callTool.bind(client);
  let searchArgs;
  client.callTool = async (name, args) => {
    if (name === 'search_workflows') {
      searchArgs = args;
      return {
        workflows: [{ id: 'workflow-123', name: identity.name }],
      };
    }
    return baseCall(name, args);
  };
  const recovered = await recoverUnknownInstallation({
    client,
    manifest: WORKFLOW_MANIFEST,
    state,
    workflowId: '',
  });
  assert.equal(recovered.workflowId, 'workflow-123');
  assert.equal(state.status, 'installed');
  assert.equal(calls.some(({ name }) => name === 'create_workflow_from_code'), false);
  assert.deepEqual(searchArgs, { query: identity.name, limit: 20 });

  const ambiguousState = {
    createAttempted: true,
    status: 'unknown',
    identity,
    settings,
    workspaceOrigin: WORKSPACE,
  };
  const ambiguous = fakeClient();
  ambiguous.client.tools.add('search_workflows');
  ambiguous.client.callTool = async (name) => {
    if (name === 'search_workflows') {
      return {
        workflows: [
          { id: 'workflow-123', name: identity.name },
          { id: 'workflow-456', name: identity.name },
        ],
      };
    }
    throw new Error('details must not run for an ambiguous recovery');
  };
  await assert.rejects(recoverUnknownInstallation({
    client: ambiguous.client,
    manifest: WORKFLOW_MANIFEST,
    state: ambiguousState,
    workflowId: '',
  }), { code: 'INSTALL_AMBIGUOUS' });
  assert.equal(ambiguous.calls.some(({ name }) => name === 'create_workflow_from_code'), false);
});

test('readback rejects active, missing-node, connection, parameter, timezone, and execution-option changes', async () => {
  const identity = makeInstallationIdentity('MEKA LinkedIn Jobs', 'ABCD2345');
  const cases = [
    (workflow) => { workflow.active = true; },
    (workflow) => { workflow.nodes.pop(); },
    (workflow) => { workflow.connections = {}; },
    (workflow) => { workflow.nodes[10].parameters.changed = true; },
    (workflow) => { workflow.settings.timezone = 'Europe/London'; },
    (workflow) => {
      workflow.nodes.find((node) => node.name === 'Start Actor').retryOnFail = true;
    },
    (workflow) => {
      workflow.nodes.find((node) => node.name === 'Read Existing Jobs').disabled = true;
    },
    (workflow) => {
      workflow.nodes.find((node) => node.name === 'Append Rows').continueOnFail = true;
    },
  ];
  for (const change of cases) {
    await assert.rejects(verifyInstalledWorkflow({
      details: detailsFor(settings, change),
      manifest: WORKFLOW_MANIFEST,
      settings,
      workflowId: 'workflow-123',
      workflowName: identity.name,
      workspaceOrigin: WORKSPACE,
    }));
  }

  const withoutCredentialReferences = detailsFor(settings);
  assert.equal(
    withoutCredentialReferences.workflow.nodes.some((node) => node.credentials),
    false,
  );
  assert.equal((await verifyInstalledWorkflow({
    details: withoutCredentialReferences,
    manifest: WORKFLOW_MANIFEST,
    settings,
    workflowId: 'workflow-123',
    workflowName: identity.name,
    workspaceOrigin: WORKSPACE,
  })).graphVerified, true);
});

test('reload recovery rechecks salted search-settings proof and rejects a changed budget', async () => {
  const identity = makeInstallationIdentity('MEKA LinkedIn Jobs', 'ABCD2345');
  const settingsProof = await createSettingsProof(settings);
  const state = {
    createAttempted: true,
    status: 'created-unverified',
    identity,
    workspaceOrigin: WORKSPACE,
    workflowId: 'workflow-123',
    settingsProof,
  };

  const recovered = await recoverUnknownInstallation({
    client: fakeClient().client,
    manifest: WORKFLOW_MANIFEST,
    state,
    workflowId: '',
  });
  assert.equal(recovered.searchSettingsReadbackVisibility, 'exact-via-salted-digest');
  assert.equal(state.status, 'installed');

  const tamperedState = {
    ...state,
    status: 'created-unverified',
  };
  const tamperedSettings = { ...settings, budgetUsd: 0.06 };
  const tampered = fakeClient({
    details: detailsFor(tamperedSettings),
  });
  await assert.rejects(recoverUnknownInstallation({
    client: tampered.client,
    manifest: WORKFLOW_MANIFEST,
    state: tamperedState,
    workflowId: '',
  }), { code: 'WORKFLOW_SEARCH_SETTINGS_MISMATCH' });
  assert.equal(tampered.calls.some(({ name }) => name === 'create_workflow_from_code'), false);
});

test('recovery marker survives storage without search settings or credential IDs', async () => {
  const storage = createMemorySessionStore();
  const identity = makeInstallationIdentity('MEKA LinkedIn Jobs', 'ABCD2345');
  const privateSettings = {
    ...settings,
    keywords: 'private-query-sentinel',
    location: 'private-location-sentinel',
    spreadsheetTitle: 'private-title-sentinel',
  };
  saveInstallRecovery(storage, {
    createAttempted: true,
    status: 'created-unverified',
    identity,
    workspaceOrigin: WORKSPACE,
    workflowId: 'workflow-123',
    settings: privateSettings,
    settingsProof: await createSettingsProof(privateSettings),
    apifyCredentialId: 'private-apify-credential',
    googleCredentialId: 'private-google-credential',
  });
  const raw = storage.get('meka.n8n.installer.recovery');
  assert.doesNotMatch(raw, /private-query-sentinel|private-location-sentinel|private-title-sentinel/u);
  assert.doesNotMatch(raw, /private-apify-credential|private-google-credential/u);
  const restored = loadInstallRecovery(storage);
  assert.equal(restored.settings, undefined);
  assert.equal(restored.workflowId, 'workflow-123');
  assert.match(restored.settingsProof.digest, /^[0-9a-f]{64}$/u);
});
