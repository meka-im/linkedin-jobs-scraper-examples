# n8n Cloud auto-setup variant

[`linkedin-jobs-cloud.json`](../n8n/linkedin-jobs-cloud.json) is an opt-in convenience variant of the main workflow. It uses OAuth credentials and creates or recovers its own Google spreadsheet, so you do not copy a spreadsheet ID or prepare the `Jobs` worksheet by hand.

The exact imported artifact, SHA-256 `fcdb945365562ec97243d353b344ecc67b1a9738c310d15cfe18f130122dd85b`, was accepted on n8n Cloud **2.45.3 Experimental** with the official verified `@apify/n8n-nodes-apify` **0.8.1** package. Two Manual Trigger runs completed against one workflow-created spreadsheet, and the schedule remained inactive. The [sanitized acceptance evidence](../validation/2026-10-25/cloud-auto-setup-acceptance.json) contains the run counts and verification boundaries without workspace, account, spreadsheet, run, or execution IDs.

The variant has no public n8n template ID or URL. Those exist only after n8n approves a submission.

## Quick path

1. Import [`linkedin-jobs-cloud.json`](../n8n/linkedin-jobs-cloud.json) as a new inactive workflow and save it.
2. Create or choose the managed **Apify OAuth2** and **Google Sheets OAuth2** credentials. Set the exact HTTP domains described below, then open all 14 credential-bearing nodes, confirm the matching credential, and save.
3. Set `keywords` and `location`, review the advanced search settings and spending cap, save, and run the **Manual Trigger**. The workflow creates or reuses the tagged spreadsheet and exact `Jobs` header before starting the Actor.

The JSON import does not bind credentials, and Cloud may report `Credentials not found` until the 14-node confirmation pass is saved. There is no public template button and no promise of one-click or two-click setup. Account connection, node confirmation, and search selection remain user steps.

## Accepted Cloud snapshot

| Run | Fetched | New | Appended | Existing IDs skipped | Batch duplicates skipped | Cache hits | Coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 10 | 10 | 10 | 0 | 0 | 0 | `complete` |
| 2 | 10 | 0 | 0 | 10 | 0 | 10 | `complete` |

Both runs used `keywords: "software engineer"`, `location: "London, United Kingdom"`, `pastWeek`, a 10-result limit, a USD `0.05` Actor charge cap, and `scrapeCompany: false`. Both runs reported zero failed searches, failed job details, failed companies, and did not stop by budget. The workflow created the first spreadsheet automatically and reused the same `ready` spreadsheet on the second run.

The source artifact declares `timezone: "UTC"`, but the Cloud import omitted `settings.timezone`, so both manual acceptance runs used the instance-default timezone. After those runs, the acceptance workflow's Settings changed from the instance-only `Asia/Shanghai` default to `Etc/UTC`; it was saved, reopened, and read back as `Etc/UTC`. That setting change did not rerun the Actor and the workflow was not published. Before enabling your own schedule, explicitly choose `Etc/UTC` or your local timezone, verify what **08:00** means, and save the selection.

After run 1, an independent **Read Existing Jobs** returned 10 rows. After run 2, it returned those same 10 rows with `row_number`, all ten business fields, and `firstSeenAt` unchanged. The Sheets UI showed `Jobs!A1:J11`: the exact ten-column header plus 10 unique jobs, with 100/100 first-run business-field values preserved and no duplicate IDs. This subsection records the observed runs; it does not claim universal latency, broader coverage, or future append behavior.

## What it automates

After one successful bootstrap, the same workflow ID maps to one Google spreadsheet:

1. Validate `keywords`, `location`, date window, result limit, budget, company-scrape setting, and `$workflow.id`.
2. Search Google Drive for one spreadsheet tagged with `mekaLinkedinJobsWorkflow=<current workflow ID>`.
3. Create a Google spreadsheet only when no tagged file exists.
4. Recover a newly created file whose create response was lost by searching for the same `pending` tag on the next run.
5. Add a `Jobs` worksheet if the file is still pending.
6. Read only `Jobs!A1:J1` on normal runs. If a `pending` worksheet has an empty header, perform one bounded confirmation across that worksheet's current grid and write the exact ten-column header only when every cell is empty.
7. Mark the file `ready`.
8. Enter the original `Input Validation` and Actor/Sheets chain with the resolved spreadsheet ID and fixed `Jobs` worksheet name.

Bootstrap must complete before `Start Actor`. A Drive, Sheets, schema, HTTP-status, 30-second HTTP timeout, or header validation failure stops the execution before the billable Actor start. Every bootstrap Google HTTP node has an explicit 30-second timeout.

The execution chain keeps the original four Apify HTTP requests and the original Actor `OUTPUT`, polling, result-limit, budget-cap, and no-retry behavior. Only their authentication parameters change to `predefinedCredentialType` / `apifyOAuth2Api`. Existing Google Sheets read, deduplication, `RAW` append, ten-field mapping, and `firstSeenAt` behavior remain unchanged.

## Prerequisites

- An n8n Cloud workspace that permits the official verified Apify community node package `@apify/n8n-nodes-apify`. That package supplies the `apifyOAuth2Api` credential definition used by the HTTP Request nodes.
- An Apify account.
- A Google account that can create and edit Google Sheets files through the **Google Sheets OAuth2** credential.
- A saved n8n workflow. `$workflow.id` is not available for an unsaved manual test.

Cloud plans and n8n versions can differ in community-node installation and credential selectors. Confirm those UI capabilities in the actual workspace; this repository does not assume that all plans expose every community node.

## 1. Import and save

1. In n8n, create a new inactive workflow.
2. Import [`linkedin-jobs-cloud.json`](../n8n/linkedin-jobs-cloud.json) from a file. Use the raw repository URL only after this variant is published on the default branch.
3. Save the workflow before its first manual execution.

The workflow arrives inactive and contains no credential objects, tokens, spreadsheet IDs, or account identifiers.

## 2. Connect Apify OAuth

1. Install or enable the official `@apify/n8n-nodes-apify` community node package if your n8n workspace does not already provide it.
2. Create one **Apify OAuth2** credential and use **Connect my account** to authorize the account that should pay for Actor runs.
3. In the credential's **Connection** settings, set **Allowed HTTP Request Domains** to **Specific Domains** and add `api.apify.com`. The default **None** prevents this credential from being used by HTTP Request nodes; selecting **All** is unnecessary.
4. The current official Apify OAuth credential requests the `profile` and `full_api_access` scopes. This grants n8n full API access to the selected Apify account, beyond access to this one Actor.
5. Select that credential on:
   - **Start Actor**
   - **Poll Actor Run**
   - **Get Run Output**
   - **Get Dataset Items**

Some exported workflows require you to reopen credential-bearing nodes and select the credential again after import. If every node does not preserve the same credential automatically, select it on the four nodes above before running.

If you prefer a dedicated HTTP Header Auth token with narrower permissions, use the original [HTTP Header Auth workflow](../n8n/linkedin-jobs-to-google-sheets.json) as the optional fallback. Use the same fallback if the `apifyOAuth2Api` credential type is unavailable, the community-node package is not active, or your n8n version cannot attach it to HTTP Request nodes. That workflow keeps the original local/import fingerprint.

## 3. Connect Google OAuth

Create one **Google Sheets OAuth2** credential and authorize the Google account that should own the generated spreadsheet. n8n's managed Google connection provides the credential; you do not put Google credentials in this repository.

In the credential's **Connection** settings, set **Allowed HTTP Request Domains** to **Specific Domains** and enter `www.googleapis.com,sheets.googleapis.com`. The default **None** prevents this credential from being used by HTTP Request nodes; use these exact comma-separated hosts and do not select **All**.

The credential needs access to Drive file search/create/update and Sheets metadata/values operations. This variant uses it on all Google HTTP nodes:

- **Find App Spreadsheet**
- **Create App Spreadsheet**
- **Get Spreadsheet Metadata**
- **Add Jobs Worksheet**
- **Get Jobs Header**
- **Confirm Jobs Worksheet Empty**
- **Write Jobs Header**
- **Mark Spreadsheet Ready**

Select the same credential on **Read Existing Jobs** and **Append Rows** as well. Credential IDs are intentionally not exported.

OAuth access belongs to the connection created in your n8n instance. Do not commit OAuth exports, account IDs, file IDs, response bodies, or screenshots containing private data.

### Confirm credential bindings after import

This workflow has 14 credential-bearing nodes: four Apify HTTP nodes, eight Google bootstrap HTTP nodes, and the original **Read Existing Jobs** and **Append Rows** nodes. Importing the JSON does not carry or bind all credential IDs. After import, open each of the 14 nodes, confirm or select the matching existing credential, and save the workflow.

When the workspace has exactly one credential of the required type, n8n Cloud may pre-select it as you open a node. It still requires confirmation and saving on each affected node. A first API node can report `Credentials not found` before that binding pass is saved.

In the accepted Cloud workspace, saving the credentials without opening and confirming every node was not sufficient. That preflight stopped at **Assess Drive Search** with HTTP status `NO_STATUS` and the HTTP output `Credentials not found`; it started zero Actor runs. Confirming all 14 bindings resolved the setup issue before any paid run.

## 4. Configure the search

Open **Search settings**. Set at least:

- `keywords`: the LinkedIn search text.
- `location`: the market text.

The exported starting values are:

| Field | Default | Purpose |
| --- | --- | --- |
| `keywords` | `software engineer` | Search text. |
| `location` | `London, United Kingdom` | Search market. |
| `datePosted` | `pastWeek` | Actor date window. Advanced setting. |
| `limit` | `10` | Result cap and expected maximum Dataset size. Advanced setting. |
| `budgetUsd` | `0.05` | Actor maximum charge cap. Advanced setting. |
| `scrapeCompany` | `false` | Optional company enrichment. Advanced setting. |
| `spreadsheetTitle` | `LinkedIn jobs` | Title used only when creating a new spreadsheet. Optional. |

There is no `sheetId` field. The workflow resolves the spreadsheet from its Drive tag and always uses the worksheet title `Jobs`.

## 5. Run the first test

1. Save the workflow and all credential selections.
2. Run the **Manual Trigger**.
3. Follow the execution through bootstrap, `Input Validation`, the Actor run, sheet read, ID filtering, and `Run Summary`.
4. Open the generated spreadsheet and confirm that a `Jobs` worksheet contains row 1 with:

   ```text
   id	title	company	location	postedAt	url	salary	employmentType	seniority	firstSeenAt
   ```

5. Run the workflow a second time and verify that it reuses the same spreadsheet, reads existing IDs, and appends only unseen jobs.

Google may leave the newly created spreadsheet's default `Sheet1` in place. The workflow adds or uses `Jobs`; it does not rewrite or delete `Sheet1`.

The schedule remains inactive. After the manual test succeeds, open **Workflow settings -> Timezone**, explicitly choose `Etc/UTC` or your local timezone, verify what **08:00** means, save, and reopen the setting to confirm it. Activate the schedule deliberately only after that check. Each Actor execution can incur Apify charges.

## Persistence and recovery

The workflow does not store the spreadsheet ID in n8n `staticData`, because manual and scheduled executions cannot rely on that value remaining available. Persistence lives in Drive app properties on the generated spreadsheet:

- `mekaLinkedinJobsWorkflow`: the n8n workflow ID.
- `mekaLinkedinJobsBootstrapState`: `pending` or `ready`.
- `mekaLinkedinJobsSchemaVersion`: currently `1`.

Drive creation is not retried automatically. If the create request reaches Google but its response is lost, the execution fails before the Actor step. On the next run, the Drive lookup finds the `pending` file with the same workflow tag and continues with that file instead of creating another.

The same recovery model applies to a lost worksheet-add, header-write, or ready-marker response. The next run rereads Google state:

- A missing `Jobs` worksheet is added only while the file is `pending`.
- An empty `Jobs` worksheet gets the exact header only while the file is `pending`; before writing, one bounded grid read confirms that no other cell contains data.
- An exact existing header is reused, including all existing data rows.
- A lost ready-marker response is retried while the Drive state still says `pending`.

Daily runs request only `Jobs!A1:J1` for this preflight. The full current grid is loaded only on the one-time `pending` empty-header confirmation, using row and column bounds returned by the Sheets metadata request. The original **Read Existing Jobs** node still reads the table once in the paid execution path.

The workflow refuses to guess when recovery is ambiguous:

- More than one tagged file, or a second Drive result page, fails before the Actor step.
- A `ready` file with no `Jobs` worksheet fails before the Actor step. It is not reset.
- A `ready` file whose header was erased or changed fails before the Actor step. It is not repaired or reset automatically.
- A non-empty worksheet whose row 1 is not exactly the ten expected headers fails before the Actor step. No user content is overwritten.
- An unexpected app-property schema version fails instead of silently migrating data.

Renaming the spreadsheet in Drive is safe because lookup uses the workflow app property. Renaming the `Jobs` worksheet is not supported after bootstrap; restore that exact title or deliberately repair the file after inspecting its data.

Each generated sheet is tied to one n8n workflow ID. Exporting and importing the workflow usually gives it a new ID, so the imported copy creates or reuses a different spreadsheet. For the same reason, do not clone the workflow casually if both copies should share one sheet.

Use one workflow and one writer per generated sheet. The design leaves concurrency to n8n and Google and does not claim a global lock. Two overlapping initial executions can race while creating or adding the worksheet, and two overlapping Actor/Sheets executions can both observe the same unseen job ID before either append finishes. Keep executions serial and activate the schedule only after a successful manual run.

## OAuth compatibility probe

Before testing the full workflow, a maintainer can import [`cloud-auth-smoke.workflow.json`](../tests/fixtures/cloud-auth-smoke.workflow.json). It makes only two GET requests:

1. `GET https://api.apify.com/v2/users/me` with `apifyOAuth2Api`.
2. A zero-match Google Drive files query with `googleSheetsOAuth2Api`.

The Drive query uses the unlikely tag `mekaCloudAuthSmoke=never-created`, requests only `files(id)` and `nextPageToken`, and has `pageSize=1`. It does not create a file, update metadata, write a cell, or start an Actor.

The fixture contains no credentials or private IDs. Both GET requests passed on n8n Cloud 2.45.3 Experimental after restricting Apify OAuth to `api.apify.com` and Google OAuth to `www.googleapis.com,sheets.googleapis.com`. Public evidence records only sanitized success/failure fields, never account details or raw responses.

## Troubleshooting

### `$workflow.id` is missing

Save the workflow first, then run the saved version. An unsaved manual execution cannot provide a stable persistence key.

### The Apify credential type is missing

Confirm that `@apify/n8n-nodes-apify` is available to this workspace and loaded before the workflow. If the hosted environment cannot expose `apifyOAuth2Api` on HTTP Request nodes, use the original Header Auth workflow rather than weakening the Actor checks.

### An HTTP Request rejects the Apify OAuth credential

If n8n reports `This credential is configured to prevent use within an HTTP Request or GraphQL node`, open the **Apify OAuth2** credential's **Connection** settings. Set **Allowed HTTP Request Domains** to **Specific Domains**, add `api.apify.com`, save the credential, and rerun the read-only OAuth smoke. Keep **All** unselected.

### An HTTP Request rejects the Google OAuth credential

If n8n reports `This credential is configured to prevent use within an HTTP Request or GraphQL node`, open the **Google Sheets OAuth2** credential's **Connection** settings. Set **Allowed HTTP Request Domains** to **Specific Domains**, enter `www.googleapis.com,sheets.googleapis.com`, save the credential, and rerun the read-only OAuth smoke. Keep **All** unselected.

### A Google node has no selected credential

Open the node, select the same Google Sheets OAuth2 credential, and save the workflow. Re-exporting workflows does not carry credential IDs.

### `Credentials not found` before the first API request

Open each of the 14 credential-bearing nodes, confirm the matching credential, and save the workflow before rerunning. Existing credentials are not rejected or missing merely because an imported JSON has no credential IDs. If exactly one matching credential exists, Cloud may select it when you open the node, but it still requires confirmation for each node.

### Drive returns `403` or only some files

Reconnect the Google credential and confirm that its granted scopes include Drive metadata/file access and Sheets access. Files created under an insufficient `drive.file` scope can only be seen by the same OAuth app that created them.

### More than one tagged spreadsheet is reported

Inspect the tagged files in Drive. Merge or retain the intended file deliberately, then remove the workflow tag from duplicates only after confirming their contents. The workflow will not select one arbitrarily.

### The `Jobs` worksheet was replaced by `Sheet1`

For a `pending` bootstrap, the workflow adds `Jobs` and leaves `Sheet1` alone. If a later run reports that a `ready` file is missing `Jobs` or has an erased/changed header, inspect and repair the file deliberately. The workflow does not reset a ready file.

### The header check fails

Row 1 must contain exactly the ten documented values in order. For a `pending` worksheet with an empty row 1, the bounded empty-worksheet confirmation fails if any other cell contains data. It will not overwrite a user-created schema. A `ready` worksheet with an empty or changed header also fails and is not reset automatically.

## Evidence boundary

The automated repository tests cover artifact reproducibility, exact preservation of the original core Actor/Sheets behavior, embedded Code-node logic, 30-second Google HTTP timeouts, the bounded daily header read, pending-only empty-grid confirmation, the official Google Sheets `UpdateValuesResponse` shape, HTTP status failures, creation/reuse/recovery states, duplicate-file rejection, header safety, and absence of embedded credentials or private IDs.

The separate hosted acceptance is recorded in [`cloud-auto-setup-acceptance.json`](../validation/2026-10-25/cloud-auto-setup-acceptance.json). It covers the exact imported artifact, managed OAuth compatibility, preflight binding failure before Actor start, two bounded Manual Trigger runs, automatic spreadsheet creation and reuse, schema/header verification, and unchanged existing rows. Offline tests and live acceptance remain distinct forms of evidence.
