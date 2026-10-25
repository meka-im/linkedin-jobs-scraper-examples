#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const root = path.resolve(here, '..');
export const sourceWorkflowPath = path.join(
  root,
  'n8n',
  'linkedin-jobs-to-google-sheets.json',
);
export const templateWorkflowPath = path.join(
  root,
  'n8n',
  'linkedin-jobs-to-google-sheets-template.json',
);
export const templateTitle = 'Monitor new LinkedIn jobs daily in Google Sheets with MEKA';
export const beforeRunningStickyId = '84219f0b-d510-4d5c-bca6-c65a9d61ec1d';

export const templateStickyContent = `## Before running

**Who it is for:** Recruiters, job seekers, researchers, and teams tracking one public LinkedIn search in a Google Sheet.

**How it works:** The workflow runs the MEKA LinkedIn Jobs Scraper through Apify, verifies Actor OUTPUT, reads existing IDs, and appends only unseen public jobs. The Manual Trigger supports a supervised first run. The daily Schedule Trigger stays inactive until enabled.

**Setup:**

1. Create a Google Sheet with a \`Jobs\` worksheet. Put these exact headers in A1: \`id\`, \`title\`, \`company\`, \`location\`, \`postedAt\`, \`url\`, \`salary\`, \`employmentType\`, \`seniority\`, \`firstSeenAt\`.
2. In **Search settings**, enter your spreadsheet document ID and adjust keywords, location, limit, and budget.
3. Create **HTTP Header Auth** named \`Authorization\` with value \`Bearer <APIFY_TOKEN>\` and select it on **Start Actor**, **Poll Actor Run**, **Get Run Output**, and **Get Dataset Items**.
4. Connect **Google Sheets OAuth2** to **Read Existing Jobs** and **Append Rows**.
5. In **Workflow settings -> Timezone**, choose \`Etc/UTC\` or your local timezone, then verify what the Daily Schedule's 08:00 means. Imports can use the n8n instance default even when the JSON declares UTC.
6. Save, run the Manual Trigger, and inspect the execution and sheet. Enable the schedule only after that test succeeds.

**Requirements:** an Apify token, a Google account that can edit the sheet, and n8n credentials for both services. This JSON contains no credentials or private spreadsheet ID.

**Customize:** change the search, date window, limit, budget, worksheet name, or schedule. A result limit is not full-market coverage.

Repository: https://github.com/meka-im/linkedin-jobs-scraper-examples

MEKA Actor: https://apify.com/meka.im/linkedin-jobs-scraper`;

export function buildTemplateWorkflow(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Workflow source must be a JSON object');
  }
  if (!Array.isArray(source.nodes)) {
    throw new Error('Workflow source must contain a nodes array');
  }

  const template = structuredClone(source);
  template.name = templateTitle;

  const sticky = template.nodes.find(({ id }) => id === beforeRunningStickyId);
  if (!sticky) {
    throw new Error(`Workflow sticky ${beforeRunningStickyId} was not found`);
  }
  if (sticky.type !== 'n8n-nodes-base.stickyNote') {
    throw new Error(`Workflow node ${beforeRunningStickyId} is not a sticky note`);
  }
  if (!sticky.parameters || typeof sticky.parameters !== 'object') {
    throw new Error(`Workflow sticky ${beforeRunningStickyId} has no parameters`);
  }
  sticky.position = [-1180, -1300];
  sticky.parameters.content = templateStickyContent;
  sticky.parameters.width = 1000;
  sticky.parameters.height = 1000;
  return template;
}

export async function buildTemplateFile() {
  const source = JSON.parse(await readFile(sourceWorkflowPath, 'utf8'));
  const template = buildTemplateWorkflow(source);
  await writeFile(templateWorkflowPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return template;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await buildTemplateFile();
  console.log(`Wrote ${path.relative(root, templateWorkflowPath)}`);
}
