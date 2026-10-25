import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = JSON.parse(
  await readFile(path.join(root, 'n8n', 'linkedin-jobs-to-google-sheets.json'), 'utf8'),
);
const code = (name) => {
  const found = workflow.nodes.find((node) => node.name === name);
  if (!found?.parameters?.jsCode) throw new Error(`Missing Code node: ${name}`);
  return found.parameters.jsCode;
};

const node = (id, name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters,
  id,
  name,
  type: `n8n-nodes-base.${type}`,
  typeVersion,
  position,
  ...extra,
});

const ifNode = (id, name, expression, position) => node(
  id,
  name,
  'if',
  2.2,
  position,
  {
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: '',
        typeValidation: 'strict',
        version: 2,
      },
      conditions: [{
        id: `${id}-condition`,
        leftValue: `={{ ${expression} }}`,
        rightValue: '',
        operator: {
          type: 'boolean',
          operation: 'true',
          singleValue: true,
        },
      }],
      combinator: 'and',
    },
    options: {},
  },
);

const smoke = {
  id: 'mekaLinkedInCodeSmoke20261024',
  name: 'MEKA LinkedIn jobs Code-node smoke',
  nodes: [
    node('smoke-manual', 'Manual Trigger', 'manualTrigger', 1, [-1200, 0], {}),
    node('smoke-settings', 'Fixture Settings', 'code', 2, [-960, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `return [{
  json: {
    keywords: 'software engineer',
    location: 'London, United Kingdom',
    datePosted: 'pastWeek',
    limit: 25,
    budgetUsd: 0.05,
    scrapeCompany: false,
    sheetId: 'smoke_sheet_id',
    sheetName: 'Jobs'
  }
}];
`,
    }),
    node('smoke-validation', 'Input Validation', 'code', 2, [-720, 0], {
      mode: 'runOnceForAllItems',
      jsCode: code('Input Validation'),
    }),
    node('smoke-start-response', 'Start Response', 'code', 2, [-480, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `return [{
  json: {
    body: {
      data: {
        id: 'smoke-run',
        status: 'RUNNING',
        defaultDatasetId: 'smoke-dataset'
      }
    }
  }
}];
`,
    }),
    node('smoke-assess-start', 'Assess Start Run', 'code', 2, [-240, 0], {
      mode: 'runOnceForAllItems',
      jsCode: code('Assess Start Run'),
    }),
    node('smoke-wait', 'Wait for Actor', 'code', 2, [0, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `return $input.all();
`,
    }),
    node('smoke-poll-response', 'Poll Response', 'code', 2, [240, 0], {
      mode: 'runOnceForAllItems',
      jsCode: `const state = $('Wait for Actor').first()?.json ?? {};
const nextPoll = Number(state.pollCount ?? 0) + 1;
return [{
  json: {
    body: {
      data: {
        id: state.runId,
        status: nextPoll >= 2 ? 'SUCCEEDED' : 'RUNNING',
        defaultDatasetId: state.datasetId
      }
    }
  }
}];
`,
    }),
    node('smoke-assess-poll', 'Assess Polled Run', 'code', 2, [480, 0], {
      mode: 'runOnceForAllItems',
      jsCode: code('Assess Polled Run'),
    }),
    ifNode('smoke-success-if', 'Is Run Succeeded?', "$json.nextAction === 'fetch'", [720, 0]),
    node('smoke-output-response', 'Run Output Response', 'code', 2, [960, -160], {
      mode: 'runOnceForAllItems',
      jsCode: `return [{
  json: {
    body: {
      status: 'completed',
      delivered: 2,
      uniqueJobs: 2,
      searchPages: 1,
      failedSearches: 0,
      failedJobDetails: 0,
      failedCompanies: 0,
      stoppedByBudget: false,
      cacheHits: 0
    }
  }
}];
`,
    }),
    node('smoke-assess-output', 'Assess Run Output', 'code', 2, [1200, -160], {
      mode: 'runOnceForAllItems',
      jsCode: code('Assess Run Output'),
    }),
    node('smoke-dataset-response', 'Dataset Response', 'code', 2, [1440, -160], {
      mode: 'runOnceForAllItems',
      jsCode: `return [{
  json: {
    body: [
      {
        id: '1001',
        title: 'Smoke Test Engineer',
        companyName: 'Example Co',
        location: 'London, United Kingdom',
        postedAt: '2026-10-24',
        link: 'https://www.linkedin.com/jobs/view/ing%C3%A9nieur%20logiciel-1001?keywords=software%20engineer',
        salary: '',
        employmentType: 'Full-time',
        seniorityLevel: 'Mid-Senior level'
      },
      {
        id: '1002',
        title: 'Second Smoke Test Engineer',
        companyName: 'Example Co',
        location: 'London, United Kingdom',
        postedAt: '2026-10-24',
        link: 'https://uk.linkedin.com/jobs/view/développeur-logiciel-1002',
        salary: '',
        employmentType: 'Full-time',
        seniorityLevel: 'Mid-Senior level'
      }
    ]
  }
}];
`,
    }),
    node('smoke-normalize', 'Normalize Jobs', 'code', 2, [1680, -160], {
      mode: 'runOnceForAllItems',
      jsCode: code('Normalize Jobs'),
    }),
    node('smoke-empty-sheet', 'Empty Sheet Placeholder', 'code', 2, [1920, -160], {
      mode: 'runOnceForAllItems',
      jsCode: `return [{ json: { row_number: 2 } }];
`,
    }),
    node('smoke-filter', 'Filter New IDs', 'code', 2, [2160, -160], {
      mode: 'runOnceForAllItems',
      jsCode: code('Filter New IDs'),
    }),
    ifNode('smoke-new-if', 'Has New Jobs?', '$json.hasNewJobs', [2400, -160]),
    node('smoke-split', 'Split Out New Jobs', 'splitOut', 1, [2640, -240], {
      fieldToSplitOut: 'newJobs',
      options: {},
    }),
    node('smoke-verify', 'Verify Smoke Result', 'code', 2, [2880, -240], {
      mode: 'runOnceForAllItems',
      jsCode: `const pollState = $('Assess Polled Run').first()?.json ?? {};
const outputState = $('Assess Run Output').first()?.json ?? {};
const normalized = $('Normalize Jobs').first()?.json ?? {};
const filtered = $('Filter New IDs').first()?.json ?? {};
const flatItems = $input.all();

if (pollState.pollCount !== 2 || pollState.status !== 'SUCCEEDED') {
  throw new Error('Expected the latest poll state to be SUCCEEDED after two polls');
}
if (outputState.pollCount !== 2 || outputState.runId !== 'smoke-run') {
  throw new Error('Assess Run Output did not recover the latest poll state');
}
if (normalized.fetchedCount !== 2 || normalized.jobs.length !== 2) {
  throw new Error('Normalize Jobs did not produce two jobs');
}
if (filtered.summary.newCount !== 2 || filtered.summary.skippedExisting !== 0) {
  throw new Error('Filter New IDs did not treat the row_number-only placeholder as empty');
}
if (flatItems.length !== 2) {
  throw new Error('Split Out New Jobs did not emit two flat items');
}

for (const [index, item] of flatItems.entries()) {
  const flat = item.json ?? {};
  if (!flat.id || flat.jobs || flat.newJobs) {
    throw new Error('Split Out New Jobs item ' + index + ' is not a flat job');
  }
  const urlPath = flat.url.replace(/[?#].*$/, '');
  const pathId = /(?:^|[-_])([0-9]+)$/.exec(urlPath)?.[1];
  if (pathId !== flat.id) {
    throw new Error('Split Out New Jobs item ' + index + ' has a URL job ID mismatch');
  }
}

return [{
  json: {
    status: 'passed',
    runId: outputState.runId,
    pollCount: pollState.pollCount,
    splitItemCount: flatItems.length,
    splitItemIds: flatItems.map((item) => item.json?.id),
    normalizedCount: normalized.fetchedCount,
    newCount: filtered.summary.newCount,
    coverage: outputState.coverage,
    urlGlobalType: typeof URL
  }
}];
`,
    }),
  ],
  connections: {
    'Manual Trigger': {
      main: [[{ node: 'Fixture Settings', type: 'main', index: 0 }]],
    },
    'Fixture Settings': {
      main: [[{ node: 'Input Validation', type: 'main', index: 0 }]],
    },
    'Input Validation': {
      main: [[{ node: 'Start Response', type: 'main', index: 0 }]],
    },
    'Start Response': {
      main: [[{ node: 'Assess Start Run', type: 'main', index: 0 }]],
    },
    'Assess Start Run': {
      main: [[{ node: 'Wait for Actor', type: 'main', index: 0 }]],
    },
    'Wait for Actor': {
      main: [[{ node: 'Poll Response', type: 'main', index: 0 }]],
    },
    'Poll Response': {
      main: [[{ node: 'Assess Polled Run', type: 'main', index: 0 }]],
    },
    'Assess Polled Run': {
      main: [[{ node: 'Is Run Succeeded?', type: 'main', index: 0 }]],
    },
    'Is Run Succeeded?': {
      main: [
        [{ node: 'Run Output Response', type: 'main', index: 0 }],
        [{ node: 'Wait for Actor', type: 'main', index: 0 }],
      ],
    },
    'Run Output Response': {
      main: [[{ node: 'Assess Run Output', type: 'main', index: 0 }]],
    },
    'Assess Run Output': {
      main: [[{ node: 'Dataset Response', type: 'main', index: 0 }]],
    },
    'Dataset Response': {
      main: [[{ node: 'Normalize Jobs', type: 'main', index: 0 }]],
    },
    'Normalize Jobs': {
      main: [[{ node: 'Empty Sheet Placeholder', type: 'main', index: 0 }]],
    },
    'Empty Sheet Placeholder': {
      main: [[{ node: 'Filter New IDs', type: 'main', index: 0 }]],
    },
    'Filter New IDs': {
      main: [[{ node: 'Has New Jobs?', type: 'main', index: 0 }]],
    },
    'Has New Jobs?': {
      main: [[{ node: 'Split Out New Jobs', type: 'main', index: 0 }]],
    },
    'Split Out New Jobs': {
      main: [[{ node: 'Verify Smoke Result', type: 'main', index: 0 }]],
    },
  },
  active: false,
  settings: {
    executionOrder: 'v1',
    timezone: 'UTC',
  },
  meta: {
    templateCredsSetupCompleted: false,
  },
};

const fixtureDirectory = path.join(root, 'tests', 'fixtures');
await mkdir(fixtureDirectory, { recursive: true });
await writeFile(
  path.join(fixtureDirectory, 'n8n-code-smoke.workflow.json'),
  `${JSON.stringify(smoke, null, 2)}\n`,
);
