import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CREDENTIAL_NODE_NAMES,
  TEMPLATE_SENTINELS,
  renderWorkflowCode,
} from './lib/workflow-code.js';
import { normalizedExecutionOptions } from './lib/node-options.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sourcePath = path.join(root, 'n8n', 'linkedin-jobs-cloud.json');
const outputDirectory = path.join(here, 'generated');
const outputTemplatePath = path.join(outputDirectory, 'workflow-template.js');
const outputManifestPath = path.join(outputDirectory, 'workflow-manifest.js');

async function loadSdk() {
  const explicitPath = process.env.MEKA_WORKFLOW_SDK_PATH;
  if (explicitPath) return import(pathToFileURL(path.resolve(explicitPath)).href);
  return import('@n8n/workflow-sdk');
}

function stripImports(code) {
  return code
    .replace(/^import[\s\S]*?from\s+['"]@n8n\/workflow-sdk['"];?\s*/mu, '')
    .replace(/^export\s+default\s+/mu, 'export default ');
}

function stable(value) {
  return JSON.stringify(value, null, 2);
}

function canonicalConnections(connections) {
  return Object.fromEntries(
    Object.entries(connections)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, outputs]) => [
        source,
        Object.fromEntries(
          Object.entries(outputs)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([kind, branches]) => [
              kind,
              branches.map((targets) => [...targets].sort((left, right) => (
                `${left.node}:${left.index}`.localeCompare(`${right.node}:${right.index}`)
              ))),
            ]),
        ),
      ]),
  );
}

function assignment(assignments, name) {
  const found = assignments.find((item) => item.name === name);
  if (!found) throw new Error(`Search settings assignment is missing: ${name}`);
  return found;
}

const sdk = await loadSdk();
const sourceBytes = await readFile(sourcePath);
const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
if (sourceHash !== '5d7c37f874e42476b224b2261e372952366f785c65af76d8994b71b66a0828c9') {
  throw new Error(`Unexpected Cloud workflow source hash: ${sourceHash}`);
}

const source = JSON.parse(sourceBytes.toString('utf8'));
if (source.nodes.length !== 42 || source.active !== false) {
  throw new Error('The Cloud workflow source does not have the expected graph.');
}

const search = source.nodes.find((node) => node.name === 'Search settings');
if (!search?.parameters?.assignments?.assignments) {
  throw new Error('Search settings node is missing.');
}
const assignments = search.parameters.assignments.assignments;
assignment(assignments, 'keywords').value = TEMPLATE_SENTINELS.keywords;
assignment(assignments, 'location').value = TEMPLATE_SENTINELS.location;
assignment(assignments, 'datePosted').value = TEMPLATE_SENTINELS.datePosted;
assignment(assignments, 'limit').value = TEMPLATE_SENTINELS.limit;
assignment(assignments, 'budgetUsd').value = TEMPLATE_SENTINELS.budgetUsd;
assignment(assignments, 'scrapeCompany').value = TEMPLATE_SENTINELS.scrapeCompany;
assignment(assignments, 'spreadsheetTitle').value = TEMPLATE_SENTINELS.spreadsheetTitle;

const credentialNodes = new Set([
  ...CREDENTIAL_NODE_NAMES.apifyOAuth2Api,
  ...CREDENTIAL_NODE_NAMES.googleSheetsOAuth2Api,
]);
let attachedCredentials = 0;
for (const node of source.nodes) {
  if (!credentialNodes.has(node.name)) continue;
  const credentialType = CREDENTIAL_NODE_NAMES.apifyOAuth2Api.includes(node.name)
    ? 'apifyOAuth2Api'
    : 'googleSheetsOAuth2Api';
  node.credentials = {
    [credentialType]: {
      id: credentialType === 'apifyOAuth2Api'
        ? '__MEKA_APIFY_CREDENTIAL_ID__'
        : '__MEKA_GOOGLE_CREDENTIAL_ID__',
      name: credentialType === 'apifyOAuth2Api'
        ? '__MEKA_APIFY_CREDENTIAL_NAME__'
        : '__MEKA_GOOGLE_CREDENTIAL_NAME__',
    },
  };
  attachedCredentials += 1;
}
if (attachedCredentials !== 15) {
  throw new Error(`Expected 15 credential nodes, found ${attachedCredentials}.`);
}

const generatedBody = sdk.generateWorkflowCode({
  workflow: source,
  includeNodeIds: true,
  includePositions: true,
});
const importLine = [
  'import {',
  '  expr,',
  '  ifElse,',
  '  newCredential,',
  '  node,',
  '  sticky,',
  '  trigger,',
  '  workflow,',
  "} from '@n8n/workflow-sdk';",
].join('\n');
const template = `${importLine}\n\n${generatedBody.trim()}\n`;

const sampleSettings = {
  keywords: 'software engineer',
  location: 'London, United Kingdom',
  datePosted: 'pastWeek',
  limit: 10,
  budgetUsd: 1,
  scrapeCompany: false,
  spreadsheetTitle: 'LinkedIn jobs',
};
const renderedSample = renderWorkflowCode({
  template,
  settings: sampleSettings,
  apifyCredential: {
    id: 'apify_credential_id',
    name: 'Apify OAuth',
    type: 'apifyOAuth2Api',
  },
  googleCredential: {
    id: 'google_credential_id',
    name: 'Google Sheets OAuth',
    type: 'googleSheetsOAuth2Api',
  },
});
const parsed = sdk.parseWorkflowCode(stripImports(renderedSample));

if (parsed.nodes.length !== 42 || Object.keys(parsed.connections).length !== 40) {
  throw new Error('SDK roundtrip did not preserve 42 nodes and 40 connections.');
}
if (
  stable(canonicalConnections(parsed.connections))
  !== stable(canonicalConnections(source.connections))
) {
  throw new Error('SDK roundtrip changed the workflow connections.');
}
if (stable(parsed.settings) !== stable(source.settings)) {
  throw new Error('SDK roundtrip changed workflow settings.');
}

for (const original of source.nodes) {
  const rebuilt = parsed.nodes.find((node) => node.name === original.name);
  if (!rebuilt || rebuilt.type !== original.type) {
    throw new Error(`SDK roundtrip changed or omitted node ${original.name}.`);
  }
  if (
    original.name !== 'Search settings'
    && stable(rebuilt.parameters) !== stable(original.parameters)
  ) {
    throw new Error(`SDK roundtrip changed parameters for node ${original.name}.`);
  }
  if (rebuilt.credentials && Object.keys(rebuilt.credentials).length !== 1) {
    throw new Error(`SDK roundtrip changed credentials for node ${original.name}.`);
  }
}

const credentialCounts = parsed.nodes.reduce((counts, node) => {
  const keys = Object.keys(node.credentials ?? {});
  for (const key of keys) {
    if (key === 'apifyOAuth2Api') counts.apify += 1;
    if (key === 'googleSheetsOAuth2Api') counts.google += 1;
  }
  return counts;
}, { apify: 0, google: 0 });
if (credentialCounts.apify !== 4 || credentialCounts.google !== 11) {
  throw new Error(`SDK roundtrip produced unexpected credential counts: ${stable(credentialCounts)}`);
}

const expectedGraph = {
  sourceSha256: sourceHash,
  templateVersion: '1',
  nodeCount: parsed.nodes.length,
  connectionCount: Object.keys(parsed.connections).length,
  nodes: parsed.nodes.map((node) => ({
    name: node.name,
    type: node.type,
    typeVersion: node.typeVersion,
    parameters: node.parameters,
    executionOptions: normalizedExecutionOptions(node),
  })),
  connections: parsed.connections,
  settings: parsed.settings,
  credentialNodeCounts: credentialCounts,
};

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  outputTemplatePath,
  `// Generated by installer/build-sdk-template.mjs; do not edit by hand.\n`
  + `// Source: n8n/linkedin-jobs-cloud.json sha256 ${sourceHash}\n`
  + `export const WORKFLOW_TEMPLATE_SHA256 = '${createHash('sha256').update(template).digest('hex')}';\n`
  + `export const WORKFLOW_TEMPLATE = ${JSON.stringify(template)};\n`,
);
await writeFile(
  outputManifestPath,
  `// Generated by installer/build-sdk-template.mjs; do not edit by hand.\n`
  + `export const WORKFLOW_MANIFEST = ${stable(expectedGraph)};\n`,
);

process.stdout.write(
  `Generated SDK template: ${parsed.nodes.length} nodes, ${Object.keys(parsed.connections).length} connections, `
  + `${credentialCounts.apify + credentialCounts.google} credential bindings.\n`,
);
