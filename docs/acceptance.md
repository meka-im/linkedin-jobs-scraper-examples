# Acceptance Notes

This page records how the example was validated and how to maintain evidence for future workflow changes. The current one-command, live API, Docker lifecycle, and Cloud two-run results are in [`validation/2026-10-25/one-command-acceptance.json`](../validation/2026-10-25/one-command-acceptance.json). The earlier local n8n measurements remain in [`validation/2026-10-25/n8n-sheets-acceptance.json`](../validation/2026-10-25/n8n-sheets-acceptance.json).

The current branch's offline suite passed **70 Node.js tests and 4 Python tests (74 total)** under Node.js `v22.22.0`. The additional four Node.js tests verify the template submission variant's title and sticky copy, executable graph, reproducible build, and absence of embedded private data. This test update does not create another live Actor, n8n Cloud, or Google Sheets execution.

## Historical Local n8n Snapshot

- Date: 2026-10-25 (Asia/Shanghai).
- Runtime: n8n 2.44.6.
- Workflow SHA-256: `8823e9720a601683197fff35a30586343f58632515e1854d7f13cd417f2299ac`.
- Workflow state: inactive, using built-in n8n nodes.
- Test configuration: `software engineer` in `London, United Kingdom`, `pastWeek`, 10 results, `scrapeCompany: false`, 512 MB Actor memory, and a USD 0.05 maximum charge.
- Changes from the exported defaults: local credential bindings, a local spreadsheet ID, and `limit` changed from 25 to 10.

The two runs used the same exported workflow and two distinct, live Actor runs. Neither run was a replay or stub.

## End-to-End Results

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

The later n8n Cloud 2.45.3 Experimental Manual Trigger runs were not schedule-time assertions: they used the instance-default timezone. After those runs, the private workflow was explicitly set to `Etc/UTC`, saved, reopened, and confirmed with the schedule still inactive. No Actor run was repeated for that settings change. The exported source still declares `timezone: "UTC"`, but import behavior must not be treated as proof that this setting was preserved.

## Supporting Checks

- The offline `npm test` suite passed 36 Node tests and 4 Python tests.
- The embedded Code nodes passed an execution in n8n 2.44.6 with `pollCount: 2`, `splitItemCount: 2`, `normalizedCount: 2`, `newCount: 2`, and `urlGlobalType: "undefined"`.
- The standalone API example returned 10 of 10 jobs on 2026-10-24.

These checks support the release decision but are not additional Google Sheets end-to-end runs. Only the two runs above are counted as complete n8n and Google Sheets acceptance runs.

## Maintaining Acceptance Evidence

1. Keep dated files under `validation/` immutable once reviewed. Add a new dated JSON file for a new measurement instead of replacing or combining historical results.
2. Record only completed measurements. Keep offline tests, Code-node smoke runs, API-only checks, and complete n8n plus Google Sheets runs separate so they are not counted as the same kind of evidence.
3. Pin the SHA-256 of the exported workflow and describe any runtime configuration that differs from its defaults.
4. Verify the persisted n8n execution and the actual sheet. Confirm row transitions, unique IDs, required columns, `firstSeenAt`, Actor coverage counters, and whether existing rows changed.
5. Use multiple sequential runs when changing deduplication behavior. Report what the later run actually appended rather than asserting that it must append zero rows.
6. Keep credentials, OAuth data, account names, spreadsheet IDs or links, Actor run IDs, Dataset IDs, execution IDs, private filesystem paths, and raw execution bodies out of public evidence.
7. Update the short validation summary in the root README whenever a new acceptance record becomes the current evidence.

For a replay, create a fresh `Jobs` sheet with the ten headers from [`sheets/jobs-header.csv`](../sheets/jobs-header.csv), configure the four Apify HTTP Request nodes and both Google Sheets nodes, keep the workflow inactive, and run it manually twice. The workflow is intended for serial, modest-volume use against one sheet.
