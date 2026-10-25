#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLinkedInJobs } from '../src/apify-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.resolve(process.argv[2] ?? path.join(here, 'input.json'));
const outputPath = path.resolve(process.argv[3] ?? path.join(process.cwd(), 'jobs.json'));
const token = process.env.APIFY_TOKEN;

try {
  if (!token) throw new Error('Set APIFY_TOKEN in your environment');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const result = await runLinkedInJobs({ token, input });
  await writeFile(outputPath, `${JSON.stringify(result.jobs, null, 2)}\n`, 'utf8');
  console.log(
    `Actor run ${result.runId} succeeded with ${result.jobs.length} job(s); wrote ${outputPath}`,
  );
  console.log(`Run summary: ${JSON.stringify(result.summary)}`);
  if (result.summary.coverage === 'partial') {
    console.error(
      'Warning: the Actor run was partial; inspect failedJobDetails, '
      + 'failedCompanies, and stoppedByBudget in the summary.',
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
