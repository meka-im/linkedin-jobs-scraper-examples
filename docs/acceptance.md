# Acceptance Notes

This page records how the example was validated and how to maintain evidence for future workflow changes. The latest reliability-onboarding result is in [`validation/2026-10-27/meka-n8n-onboarding-acceptance-safe.json`](../validation/2026-10-27/meka-n8n-onboarding-acceptance-safe.json). The historical CLI and API, Docker lifecycle, and Cloud two-run snapshots are indexed by [`validation/2026-10-25/one-command-acceptance.json`](../validation/2026-10-25/one-command-acceptance.json); the earlier local n8n measurements remain in [`validation/2026-10-25/n8n-sheets-acceptance.json`](../validation/2026-10-25/n8n-sheets-acceptance.json).

## Reliability-Onboarding Acceptance (2026-10-27)

The [sanitized acceptance record](../validation/2026-10-27/meka-n8n-onboarding-acceptance-safe.json) separates the three explicitly confirmed paid runs. The frozen predecessor fetched and appended 10 jobs in 23.138 seconds with complete coverage and zero failed counters. Independent UI comparison matched all 110 header-and-row cells, but ten repeated readback items exposed the defect fixed by `executeOnce`. That predecessor is not final-artifact acceptance.

The final `executeOnce` artifact's second run completed in 17.362 seconds. It fetched and saved three jobs and invoked readback once, but seven job-detail retrievals failed upstream, so coverage was `partial`, `failureCategory` was `partial-run`, and the UI correctly stayed amber **needs attention**. That partial result remains in the evidence.

The separately authorized third run supplied the complete final-artifact pass. It completed in 15.494 seconds with 10 fetched jobs, seven new and appended rows, three existing rows skipped, complete coverage, no budget stop, and zero failed searches/details/companies. Its manual guard remained 10 jobs, USD 0.05, and no company enrichment. The single readback call completed in 287 milliseconds. Independent UI comparison matched all 110 cells, found 10 unique IDs and every `firstSeenAt`, and confirmed the prior three-row snapshot's 40 cells were unchanged. The UI showed green **Test passed** only after verification, and the execution link opened the recorded execution. The 15.494-second runtime is a one-run snapshot, not a performance promise.

The 2026-10-27 offline suite passed **141 Node.js tests and 4 Python tests**. These offline checks are separate from the three explicitly authorized live Actor and Google Sheets runs.

## Historical Release Check Snapshot (2026-10-25)

On 2026-10-25, the fixed Node.js 22 suite passed **70 Node.js tests and 4 Python tests (74 total)**, including structural checks for the template submission variant. An `npm pack` artifact contained **8 files**, and its CLI loaded successfully with an empty npm cache from a new working directory whose path contained spaces. The same packed CLI completed the live 10-result API demo with 10 unique jobs, `coverage: "complete"`, all failed-job/search/company counters at zero, and `stoppedByBudget: false`. The packed local n8n path also passed first startup, reuse of the running container, and restart of a stopped container from a fresh empty npm cache. These are acceptance results for one release snapshot, not latency or market-coverage promises.

On n8n Cloud 2.45.3 Experimental, two Manual Trigger executions also completed with the schedule inactive and Execution Logic set to `v1` (recommended). Both runs used the unchanged public workflow, completed with `coverage: "complete"`, reported zero failed searches, failed job details, and failed companies, and did not stop by budget. The real sheet moved from 0 to 10 to 11 rows, with 11 unique IDs and no duplicates. The two Manual Trigger runs used the instance's default timezone; after those runs, the private workflow's Settings timezone was explicitly changed to `Etc/UTC`, saved, reopened, and confirmed while the schedule remained inactive. See [the current acceptance measurements](../validation/2026-10-25/one-command-acceptance.json).

At that snapshot, the offline suite passed **70 Node.js tests and 4 Python tests (74 total)** under Node.js `v22.22.0`. The additional four Node.js tests verify the template submission variant's title and sticky copy, executable graph, reproducible build, and absence of embedded private data. This test update did not create another live Actor, n8n Cloud, or Google Sheets execution.

## Historical Local n8n Snapshot

- Date: 2026-10-25 (Asia/Shanghai).
- Runtime: n8n 2.44.6.
- Workflow SHA-256: `8823e9720a601683197fff35a30586343f58632515e1854d7f13cd417f2299ac`.
- Workflow state: inactive, using built-in n8n nodes.
- Test configuration: `software engineer` in `London, United Kingdom`, `pastWeek`, 10 results, `scrapeCompany: false`, 512 MB Actor memory, and a USD 0.05 maximum charge.
- Changes from the exported defaults: local credential bindings, a local spreadsheet ID, and `limit` changed from 25 to 10.

The two runs used the same exported workflow and two distinct, live Actor runs. Neither run was a replay or stub.

## Historical Local End-to-End Results

| Check | Run 1 | Run 2 |
| --- | ---: | ---: |
| n8n `startedAt` to `stoppedAt` | 13,580 ms | 15,057 ms |
| Fetched jobs | 10 | 10 |
| Appended rows | 10 | 1 |
| Existing IDs skipped | 0 | 9 |
| Sheet rows before to after | 0 to 10 | 10 to 11 |
| Unique IDs after run | 10 | 11 |
| Duplicate IDs | 0 | 0 |
| Coverage | complete | complete |
| Failed searches / details / companies | 0 / 0 / 0 | 0 / 0 / 0 |
| Stopped by budget | false | false |
| Cache hits | 0 | 9 |

All 10 rows that existed before run 2 retained every field, including their original `firstSeenAt` values.

Run 2 appending one new job is evidence that this second real batch added a row; it is not a guarantee that another run will do the same. Search ordering and newly available jobs can change between runs. The workflow deduplicates each fetched batch against the current sheet. It does not provide full-market coverage, promise universal latency, or control the Actor cache.

## Historical n8n Cloud Evidence (2026-10-25)

Both executions used the **Manual Trigger** and left the schedule inactive. They used the same public workflow SHA-256 and private Search settings overrides for `limit: 10`, `sheetName: "CloudJobs"`, `budgetUsd: 0.05`, and `scrapeCompany: false`; no private workspace, account, spreadsheet ID, or execution ID is published here.

| Run on Cloud 2.45.3 Experimental | Fetched | Existing IDs skipped | Appended | Sheet rows |
| --- | ---: | ---: | ---: | ---: |
| First run | 10 | 0 | 10 | 0 -> 10 |
| Second run | 10 | 9 | 1 | 10 -> 11 |

Both runs reported `coverage: "complete"`, zero failed searches, zero failed job details, zero failed companies, and `stoppedByBudget: false`. The final sheet had **11 unique IDs and 0 duplicates**. Independent readback confirmed that all ten rows from the first run retained all ten fields and their original `firstSeenAt` values.

The later n8n Cloud 2.45.3 Experimental Manual Trigger runs were not schedule-time assertions: they used the instance-default timezone. After those runs, the private workflow was explicitly set to `Etc/UTC`, saved, reopened, and confirmed with the schedule still inactive. No Actor run was repeated for that settings change. The exported source still declares `timezone: "UTC"`, but import behavior must not be treated as proof that this setting was preserved.

Read the [current sanitized measurements](../validation/2026-10-25/one-command-acceptance.json), the [historical local n8n measurements](../validation/2026-10-25/n8n-sheets-acceptance.json), and the [acceptance maintenance guidance](#maintaining-acceptance-evidence). These results are not a guarantee that a later run will append the same number of jobs.

## Supporting Checks

- The offline `npm test` suite passed 36 Node tests and 4 Python tests.
- The embedded Code nodes passed an execution in n8n 2.44.6 with `pollCount: 2`, `splitItemCount: 2`, `normalizedCount: 2`, `newCount: 2`, and `urlGlobalType: "undefined"`.
- The standalone API example returned 10 of 10 jobs on 2026-10-24.

These checks support the release decision but are not additional Google Sheets
end-to-end runs. They are separate from the two historical local and two
historical Cloud runs recorded above.

## Maintaining Acceptance Evidence

1. Keep dated files under `validation/` immutable once reviewed. Add a new dated JSON file for a new measurement instead of replacing or combining historical results.
2. Record only completed measurements. Keep offline tests, Code-node smoke runs, API-only checks, and complete n8n plus Google Sheets runs separate so they are not counted as the same kind of evidence.
3. Pin the SHA-256 of the exported workflow and describe any runtime configuration that differs from its defaults.
4. Verify the persisted n8n execution and the actual sheet. Confirm row transitions, unique IDs, required columns, `firstSeenAt`, Actor coverage counters, and whether existing rows changed.
5. Use multiple sequential runs when changing deduplication behavior. Report what the later run actually appended rather than asserting that it must append zero rows.
6. Keep credentials, OAuth data, account names, spreadsheet IDs or links, Actor run IDs, Dataset IDs, execution IDs, private filesystem paths, and raw execution bodies out of public evidence.
7. Keep the root README acceptance summary to a concise status and link; update it whenever a new record becomes the current evidence.

For a replay, create a fresh `Jobs` sheet with the ten headers from [`sheets/jobs-header.csv`](../sheets/jobs-header.csv), configure the four Apify HTTP Request nodes and both Google Sheets nodes, keep the workflow inactive, and run it manually twice. The workflow is intended for serial, modest-volume use against one sheet.
