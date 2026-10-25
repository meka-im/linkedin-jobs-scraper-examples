# Setup guide

This guide takes the exported n8n workflow from import to a tested daily run. The recommended path uses **n8n Cloud managed OAuth** for Google Sheets. The workflow is inactive after import and contains no credentials, account names, or spreadsheet IDs.

<p align="center">
  <img src="../assets/setup-map.svg" width="1200" alt="Setup illustration: import the workflow, connect Apify and Google, prepare the Jobs sheet, then test and schedule.">
</p>

The setup image is an illustration, not a screenshot of the current n8n interface.

## What you need

- An [n8n Cloud](https://n8n.io/cloud/) account, or a compatible self-hosted n8n installation. The workflow was developed and end-to-end tested on n8n **2.44.6**.
- An Apify account and API token for the [MEKA LinkedIn Jobs Scraper](https://apify.com/meka.im/linkedin-jobs-scraper).
- A Google account that can create a spreadsheet and authorize Google Sheets access.
- The [workflow JSON](../n8n/linkedin-jobs-to-google-sheets.json) or its [raw download URL](https://raw.githubusercontent.com/meka-im/linkedin-jobs-scraper-examples/main/n8n/linkedin-jobs-to-google-sheets.json).

Import compatibility, Cloud support, and an end-to-end acceptance run are different kinds of evidence. The acceptance measurement in this repository used local n8n 2.44.6. It is not a claim that every n8n Cloud configuration has been end-to-end tested.

## 1. Import the workflow

The repository is not presenting this file as an n8n template-library submission. Import the JSON directly into your own workspace.

1. In n8n, create a new workflow.
2. Open the workflow menu and choose **Import from URL**.
3. Paste the [raw workflow URL](https://raw.githubusercontent.com/meka-im/linkedin-jobs-scraper-examples/main/n8n/linkedin-jobs-to-google-sheets.json).
4. If your browser downloads the response instead, download [the exported JSON](../n8n/linkedin-jobs-to-google-sheets.json), then use **Import from File**.
5. Leave the workflow inactive.

The n8n documentation describes [importing workflows from a URL or file](https://docs.n8n.io/build/manage-workflows/export-and-import.md). Menu labels can vary slightly between n8n versions.

Importing the workflow does not connect accounts, create a sheet, or start paid scheduled executions.

## 2. Connect the Apify account

Create an API token in your own Apify Console. Keep the token out of the workflow JSON, query strings, chat messages, screenshots, and repository files.

1. In n8n, open **Credentials** and create an **HTTP Header Auth** credential.
2. Set **Name** to `Authorization`.
3. Set **Value** to `Bearer <YOUR_APIFY_TOKEN>`, including the word `Bearer` and one space before the token.
4. Save the credential.
5. Open each of these four HTTP Request nodes and select the same credential:
   - **Start Actor**
   - **Poll Actor Run**
   - **Get Run Output**
   - **Get Dataset Items**

The workflow reads the Apify run and Dataset through these HTTP requests. It does not store the token in an editable workflow field.

## 3. Connect Google Sheets

### Recommended: n8n Cloud managed OAuth

1. Open **Credentials** and create a **Google Sheets OAuth2** credential.
2. Click **Sign in with Google** and authorize the Google account that should own or edit the target sheet.
3. Complete any account or consent steps shown by n8n Cloud.
4. Select that credential on both **Read Existing Jobs** and **Append Rows**.

n8n documents [managed Google OAuth for Sheets](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service/). On n8n Cloud, the recommended managed flow does not require you to create your own Google Cloud OAuth client. Google access is authorized by you; this repository and the exported workflow contain no Google credential or account ID.

### Self-hosted Google OAuth

Use the instructions that match your n8n deployment if you operate n8n yourself. A self-hosted instance may expose a custom Google OAuth2 connection instead of managed sign-in.

1. In your own Google Cloud project, enable both the **Google Sheets API** and **Google Drive API**.
2. Create an OAuth client for the deployment and configure its consent screen.
3. Configure the redirect URI exactly as instructed by the [n8n Google credential documentation](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-single-service/) and your n8n installation.
4. Create the corresponding custom OAuth2 credential in n8n.
5. Select it on **Read Existing Jobs** and **Append Rows**.
6. Complete any verification or security steps required for the scopes and audience you use.

Do not bypass a Google OAuth warning or weaken browser security controls. A working local VM or command-line test does not replace a real Google authorization check.

## 4. Create the Jobs sheet

1. Open [Google Sheets](https://sheets.google.com/create) and create a blank spreadsheet.
2. Rename the worksheet from the default name to `Jobs`.
3. Keep the `sheetName` setting in the workflow as `Jobs`.
4. Copy the header from [sheets/jobs-header.tsv](../sheets/jobs-header.tsv), or use this tab-separated line:

   ```tsv
   id	title	company	location	postedAt	url	salary	employmentType	seniority	firstSeenAt
   ```

5. Select cell **A1** and paste. Verify that the values occupy ten columns: A through J.

The file is TSV because the intended operation is a direct paste into A1. Pasting comma-separated text can put the entire line into one cell. An import that preserves cells is also acceptable, but row 1 must contain these exact header names.

The workflow matches columns by header name. The recommended header order is:

`id`, `title`, `company`, `location`, `postedAt`, `url`, `salary`, `employmentType`, `seniority`, `firstSeenAt`

The Google account selected in n8n must be able to read and append rows to this spreadsheet. Do not add a publicly shared spreadsheet to this repository, and do not publish an account ID or personal sheet link in an issue or screenshot.

### Find the spreadsheet document ID

Open your own sheet and inspect its address. A spreadsheet URL normally has this shape:

```text
https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID/edit
```

Copy the text between `/d/` and `/edit` into the workflow's `sheetId` setting. Use the ID for the file you created, not an ID from a screenshot, example, or repository document.

## 5. Configure the search

Open the **Search settings** node. The exported values are an example configuration, not a recommendation for every market or budget.

| Field | What it controls |
| --- | --- |
| `keywords` | Required, non-empty search keywords. |
| `location` | Required, non-empty location text. |
| `datePosted` | Required date window. Allowed values are `anyTime`, `past24Hours`, `pastWeek`, and `pastMonth`. The exported value is `pastWeek`. |
| `limit` | Positive integer from 1 to 1000. It is passed to the Actor as a result cap and is not a total-market coverage promise. |
| `budgetUsd` | Positive spending cap passed to the Actor as the maximum run charge. Check the current Actor page for billing details. |
| `scrapeCompany` | Boolean passed to the Actor. The exported value is `false`. |
| `sheetId` | The document ID from your own Google Sheets URL. |
| `sheetName` | The worksheet name. Keep this as `Jobs` for the documented layout. |

Smaller, focused searches are easier to inspect than a broad query that consumes the result limit across several rankings. A larger result limit or budget does not guarantee every matching public job.

The exact workflow controls, request parameters, and result semantics are documented in the [technical reference](reference.md).

## 6. Run a manual test

1. Save all credential and node changes.
2. Open the **Manual Trigger** path and execute the workflow.
3. Inspect the execution from start to finish. A successful execution reaches **Run Summary**.
4. Open the actual `Jobs` sheet and verify the header and any appended rows.
5. Confirm that `firstSeenAt` is populated for appended rows and that existing rows were not rewritten.

A successful zero-row result can be normal for a fetched batch when no unseen IDs were returned. It does not establish that no matching jobs exist across the market. A partial Actor result can also append some rows and emit a partial-coverage warning; inspect the Actor summary and [failure semantics](reference.md#output-and-coverage-semantics).

Do not activate the workflow solely because the JSON imported successfully. The first real test must cover your credentials, the target sheet, a real Actor execution, and the post-run sheet contents.

## 7. Choose when to activate

The included Schedule Trigger uses **08:00 UTC**, every day. Importing the workflow does not activate this schedule.

- Change the hour in the Schedule Trigger if 08:00 UTC is not the time you want.
- Use the workflow timezone settings supported by your n8n version when local-time behavior matters.
- Activate only after the manual run succeeds.
- Expect active executions to consume Apify resources and therefore to follow the applicable Apify billing terms.
- Use one workflow and one writer per `Jobs` sheet. Separate executions that read and append concurrently can race and add the same unseen ID twice.

## Troubleshooting

### `sheetId` is rejected

Use the spreadsheet document ID, not the spreadsheet title or a public sharing URL. Confirm that the ID is present in the `Search settings` node and matches the file you opened.

### Google authorization is missing

Check that both Google Sheets nodes use the same saved credential and that the selected Google account can edit the spreadsheet. For self-hosted n8n, recheck the OAuth client, redirect URI, consent configuration, and APIs enabled in your own project.

### The sheet append step rejects the schema

Verify the worksheet name is `Jobs` and all ten header names are spelled exactly as listed. Keep the recommended column order, especially when following this guide.

### No rows were appended

Read **Run Summary** first. A complete run with zero unseen IDs is not an error. If the summary reports partial coverage, the Actor delivered a batch with failed enrichments or stopped by budget; the result is not evidence that the market had no new jobs.

### The Actor poll reaches its limit

The execution fails with the original run ID after the bounded polling window. Inspect that run in Apify before starting a deliberate recovery attempt. The start request is not retried automatically because a retry could start another billable run.

### The actor page or pricing looks different

Use the current [Actor page](https://apify.com/meka.im/linkedin-jobs-scraper) as the source of truth. This repository does not publish a price promise.

## Security checklist

- Keep the Apify token in the n8n HTTP Header Auth credential.
- Keep Google OAuth state in n8n, not in the exported workflow.
- Do not commit `.env`, `jobs.json`, credential exports, OAuth data, execution bodies, spreadsheet IDs, or account IDs.
- Remove private data from screenshots and public issue reports.
- Use public job data in accordance with applicable law and LinkedIn's terms.

For the full failure model, compatibility notes, file inventory, and test boundaries, continue to the [technical reference](reference.md).
