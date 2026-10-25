<p align="center">
  <img src="assets/banner.svg" width="1200" alt="MEKA banner: New jobs. One clean sheet. A scheduled flow from n8n to MEKA and Google Sheets.">
</p>

<h1 align="center">LinkedIn Jobs Scraper &amp; Daily Job Monitor for n8n</h1>

<p align="center">
  Stop checking LinkedIn manually. Save matching jobs to Google Sheets daily, skip duplicates, and keep your first-seen history.
</p>

<p align="center">
  <a href="docs/cloud-setup.md">
    <img src="https://img.shields.io/badge/Cloud_auto--setup-0a7f5a?style=for-the-badge&logo=n8n&logoColor=white" alt="Open the n8n Cloud auto-setup guide">
  </a>
  <a href="#header-auth-fallback">
    <img src="https://img.shields.io/badge/Header_Auth_fallback-ea4b71?style=for-the-badge&logo=n8n&logoColor=white" alt="Use the original Header Auth workflow">
  </a>
  <a href="https://raw.githubusercontent.com/meka-im/linkedin-jobs-scraper-examples/main/n8n/linkedin-jobs-to-google-sheets.json">
    <img src="https://img.shields.io/badge/Get_Header_Auth_JSON-075cf5?style=for-the-badge&logo=n8n&logoColor=white" alt="Get the original Header Auth workflow JSON">
  </a>
  <a href="https://apify.com/meka.im/linkedin-jobs-scraper">
    <img src="https://img.shields.io/badge/Run_on_Apify-061b37?style=for-the-badge" alt="Run on Apify">
  </a>
  <a href="https://meka.im/tools/linkedin-jobs">
    <img src="https://img.shields.io/badge/Product_page-meka.im-111827?style=for-the-badge" alt="Visit the LinkedIn Jobs product page">
  </a>
</p>

<p align="center">
  <a href="docs/cloud-setup.md">Cloud auto-setup</a> &middot;
  <a href="#header-auth-fallback">Header Auth fallback</a> &middot;
  <a href="#one-command-start">One-command start</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#api-examples">API examples</a> &middot;
  <a href="#documentation">Documentation</a>
</p>

<p align="center">
  <strong>Cloud auto-setup: import &rarr; connect your accounts &rarr; save matching jobs.</strong>
  <a href="docs/cloud-setup.md">Start the Cloud guide</a><br>
  <sub>Managed OAuth creates and reuses a tagged Google spreadsheet with the exact header, so you do not copy a token, spreadsheet ID, or headers.</sub>
</p>

## Why this workflow

- **Daily schedule with an explicit timezone.** A manual trigger makes setup testable. The included Schedule Trigger is set to **08:00** but stays inactive. Before enabling it, explicitly choose the workflow timezone and verify what 08:00 means in that timezone.
- **Incremental by design.** Each run searches a recent window, deduplicates by LinkedIn job `id`, and appends only unseen rows.
- **Stable first-seen data.** Existing rows are not rewritten, so `firstSeenAt` remains the timestamp when that job first entered your sheet.
- **Small dependency surface.** The original Header Auth workflow and CLI use built-in nodes or runtime-standard features. The Cloud auto-setup variant additionally requires the official `@apify/n8n-nodes-apify` community package so HTTP Request nodes can use its Apify OAuth credential.

## Cloud auto-setup

The convenience variant was accepted on n8n Cloud **2.45.3 Experimental** with the official verified `@apify/n8n-nodes-apify` **0.8.1** package. It is still a manual JSON import until n8n approves a public template. See the [sanitized acceptance evidence](validation/2026-10-25/cloud-auto-setup-acceptance.json).

1. **Import.** Add [`n8n/linkedin-jobs-cloud.json`](n8n/linkedin-jobs-cloud.json) as a new, inactive workflow. Do not prepare a sheet or header.
2. **Connect and confirm.** Create or choose one managed Apify OAuth credential and one Google Sheets OAuth credential. The JSON carries no credential IDs, so open every credential-bearing node, confirm the matching credential, and save. The [Cloud guide](docs/cloud-setup.md) lists the nodes and exact domain restrictions.
3. **Search and test.** Set `keywords` and `location`, review the advanced date window, result limit, and spending cap, then run the **Manual Trigger**. A successful bootstrap creates or reuses one tagged spreadsheet and its exact ten-column `Jobs` worksheet, then the original deduplication and append flow takes over.

The source JSON declares `UTC`, but n8n Cloud 2.45.3 Experimental did not preserve `settings.timezone` on import. The two manual acceptance runs used the instance default. Before enabling the schedule, explicitly choose `Etc/UTC` or your local timezone, verify what **08:00** means, and save.

## How it works

<p align="center">
  <img src="assets/workflow-overview.svg" width="1200" alt="Workflow illustration: schedule, run MEKA, read the Jobs sheet, deduplicate by id, and append new rows.">
</p>

**Schedule -> MEKA -> validate `OUTPUT` -> fetch one batch -> read existing IDs -> append new rows.**

The workflow checks the Actor's `OUTPUT` counters before accepting Dataset items. A clean empty batch means no new IDs were found in that fetched batch; it does not imply full-market coverage.

## Header Auth fallback

The original [Header Auth workflow](n8n/linkedin-jobs-to-google-sheets.json)
remains available for self-hosted n8n, environments where Apify OAuth is
unavailable, and users who prefer a dedicated token with narrower permissions.
Its executable graph and local/import fingerprint are unchanged. For the
convenience path with OAuth and an automatically created sheet, use
[Cloud auto-setup](docs/cloud-setup.md).

<details>
<summary><strong>Show the manual Header Auth import and sheet setup</strong></summary>

Import the workflow into a new, inactive workflow in your own n8n workspace.
Review the included **Search settings** defaults, select your own search
options and spending cap, connect your Apify and Google accounts, run a manual
test, and activate the schedule after it succeeds. Apify and n8n Cloud may
charge for their services.

1. **Import the workflow.** In n8n, choose **Import from URL** and paste the
   raw workflow URL:

   ```text
   https://raw.githubusercontent.com/meka-im/linkedin-jobs-scraper-examples/main/n8n/linkedin-jobs-to-google-sheets.json
   ```

   If your n8n version offers only **Import from File**, download the
   [workflow JSON](https://raw.githubusercontent.com/meka-im/linkedin-jobs-scraper-examples/main/n8n/linkedin-jobs-to-google-sheets.json)
   and import that file. Keep the workflow inactive. See
   [n8n's import guide](https://docs.n8n.io/build/manage-workflows/export-and-import.md).

2. **Connect your own accounts.** For Apify, create an **HTTP Header Auth**
   credential with name `Authorization` and value
   `Bearer <YOUR_APIFY_TOKEN>`, then select it on **Start Actor**,
   **Poll Actor Run**, **Get Run Output**, and **Get Dataset Items**. For
   Google on n8n Cloud, create a **Google Sheets OAuth2** credential, click
   **Sign in with Google**, and select it on **Read Existing Jobs** and
   **Append Rows**. The JSON contains no token, account ID, or spreadsheet ID.

3. **Prepare the sheet and Search settings.** [Create a blank
   spreadsheet](https://sheets.google.com/create), rename its worksheet to
   `Jobs`, and paste the tab-separated header below into cell **A1**. Open
   **Search settings**, enter the spreadsheet document ID as `sheetId`, keep
   `sheetName` as `Jobs`, then review the keywords, location, date window,
   result limit, and spending cap. The detailed credential and sheet checklist
   is in the [setup guide](docs/setup.md).

4. **Set timezone, test, then activate.** In **Workflow settings -> Timezone**,
   choose `Etc/UTC` or your local timezone, then verify what the Daily
   Schedule's **08:00** means. Imports may use the n8n instance default even
   when the JSON declares UTC. Run the workflow manually and inspect both the
   n8n execution and the actual sheet. Activate the schedule only after that
   test succeeds.

The manual Header Auth import is available now. No public n8n template URL or
template ID exists yet.

Tested locally and on n8n Cloud, including duplicate skipping.
[Validation details](docs/acceptance.md) explain the evidence scope and limits.

**Copy this tab-separated header after opening the [TSV file](sheets/jobs-header.tsv):**

```tsv
id	title	company	location	postedAt	url	salary	employmentType	seniority	firstSeenAt
```

Paste it into **A1**. Do not paste separately comma-delimited values into A1:
Google Sheets may place that text in one cell. The workflow requires these ten
exact header names. This guide uses the worksheet name `Jobs`; another tab name
works when `sheetName` in **Search settings** matches it. The order above is
recommended, while row mapping and deduplication use the header names.

</details>

<details>
<summary><strong>Using self-hosted n8n?</strong></summary>

Self-hosted installations may use a custom Google OAuth2 credential instead of
n8n Cloud managed OAuth. Configure the Google Sheets API and Google Drive API,
create the required OAuth client in your own Google Cloud project, and complete
the provider's security requirements. Do not bypass a Google OAuth warning. The
full credential checklist is in
[docs/setup.md](docs/setup.md#self-hosted-google-oauth).

</details>

## One-command start

The commands below use the official GitHub source-package specifier. You do not need to clone the repository, change directory, or install project dependencies first.

### API only: save jobs as JSON

Requires **Node.js 22 or newer**.

```bash
npx --yes --package=github:meka-im/linkedin-jobs-scraper-examples meka-jobs
```

The default command calls the MEKA Actor with the included London `software engineer`, `pastWeek`, 10-result demo and writes the public job records to `./jobs.json`. Before the first paid request, it explains the USD 0.05 hard Actor charge cap and asks for confirmation. If `APIFY_TOKEN` is not already in the environment, an interactive terminal asks for it with echo disabled.

Use `--input <file>` for another Actor input, `--output <file>` for another result path, and `meka-jobs --help` for all options. `meka-jobs --check` reports the Node.js and token configuration without making a network request; a missing token makes the check exit nonzero.

The two `--yes` flags have different scopes:

- `npx --yes` only answers npm's package-install confirmation.
- `meka-jobs --yes` explicitly accepts the Apify request and charge cap for non-interactive use.
- `--overwrite` is a separate explicit authorization required to replace an existing output file. `--yes` does not imply `--overwrite`.

For unattended API runs, put `APIFY_TOKEN` in the environment using your shell or secret manager, then run the same command with `meka-jobs --yes`. Do not put a real token in a command copied into documentation, an issue, or a screenshot.

### Local visual n8n with the workflow pre-imported

Requires **Node.js 22 or newer** and a running **Docker Desktop or Docker Engine**.

```bash
npx --yes --package=github:meka-im/linkedin-jobs-scraper-examples meka-jobs n8n
```

The command uses the pinned official image `docker.n8n.io/n8nio/n8n:2.44.6`, publishes only `127.0.0.1:5678`, keeps n8n data in a dedicated Docker volume, and imports the bundled inactive workflow once. It waits for n8n readiness before printing `http://localhost:5678`. Use `--port <port>` if 5678 is unavailable.

After the URL opens, complete these one-time app steps in n8n:

1. Create the n8n owner account.
2. Connect the workflow's Apify HTTP Header Auth and Google Sheets OAuth2 credentials.
3. Select your own spreadsheet and complete the documented header/settings setup.
4. Open **Workflow settings -> Timezone**, choose UTC or your local timezone, and verify the Daily Schedule's 08:00 meaning.
5. Run the workflow manually and inspect both n8n and the sheet.
6. Activate the schedule only after that test succeeds.

The workflow arrives inactive. The command does not inject credentials, activate the schedule, or start a paid Actor execution.

Stop it without deleting its persistent data:

```bash
docker stop meka-linkedin-jobs-n8n
```

Resume by running the same `meka-jobs n8n` command again. The command restarts the stopped MEKA container and keeps the dedicated `meka-linkedin-jobs-n8n-data` volume. It does not provide an automatic cleanup or volume-deletion step.

Stop/start and error recovery preserve data while the pinned image and bundled workflow baseline match. The command does **not** automatically upgrade n8n or re-import a changed workflow. If the workflow baseline differs, it stops with a migration-required error rather than modifying or clearing the existing volume.

## Deduplication and sheet safety

The workflow searches `pastWeek` so daily runs overlap, reads the current `Jobs` sheet, removes duplicate IDs within the new batch, and appends only IDs that are absent from the sheet. Existing rows are left untouched. Keep one workflow and one sheet writer per deployment; two executions reading and appending at the same time can race and create duplicates.

The append node writes cells as `RAW`, so spreadsheet formulas are not evaluated. A row containing data but no valid `id` stops the execution with an explicit error instead of being treated as empty.

## Output columns

`id`, `title`, `company`, `location`, `postedAt`, `url`, `salary`, `employmentType`, `seniority`, `firstSeenAt`

Missing optional Actor values are stored as empty strings. See [the field-by-field reference](docs/reference.md#output-columns) for sources and behavior.

## API examples

The JavaScript, Python, and cURL examples use the same sample input and only runtime or standard-library features. **Choose one command below. Each example starts its own independent Actor run, which may incur charges.**

```bash
git clone https://github.com/meka-im/linkedin-jobs-scraper-examples.git
cd linkedin-jobs-scraper-examples
export APIFY_TOKEN='<YOUR_APIFY_TOKEN>'
```

<details>
<summary><strong>JavaScript example</strong> (Node.js 22 or newer)</summary>

```bash
node examples/javascript.mjs examples/input.json jobs.json
```

</details>

<details>
<summary><strong>Python example</strong> (Python 3.10 or newer)</summary>

```bash
python3 examples/python.py examples/input.json jobs.json
```

</details>

<details>
<summary><strong>cURL example</strong> (cURL plus Python 3.10 or newer)</summary>

```bash
bash examples/curl.sh examples/input.json jobs.json
```

</details>

Each selected command writes Dataset items to `jobs.json`. Change [examples/input.json](examples/input.json) to use another search. The complete polling, `OUTPUT`, validation, and failure behavior is in [the technical reference](docs/reference.md#api-request-sequence).

## FAQ

- **Which setup should I use?** Use [Cloud auto-setup](docs/cloud-setup.md) for managed Apify/Google OAuth and automatic spreadsheet creation in n8n Cloud. Use the [Header Auth fallback](#header-auth-fallback) for self-hosted n8n, unavailable Apify OAuth, or a dedicated smaller-permission token. Use the [one-command start](#one-command-start) for a local API or Docker-based n8n path.
- **Does this cover every LinkedIn job in a market?** No. Results are bounded by the Actor input, public availability, search ranking, enrichment outcomes, and spending cap. Use focused searches for broader practical coverage.
- **Is importing the Cloud JSON enough?** No. Importing does not bind credential IDs. Create or choose the two OAuth credentials, set their allowed HTTP domains, open every credential-bearing node, confirm the matching credential, save, choose the search, and run a manual test. The workflow creates and reuses the spreadsheet and exact `Jobs` header for you.
- **Does the Cloud variant need me to copy a token, sheet ID, or header?** No. Choose managed OAuth and confirm every credential-bearing node. The sheet and ten-column header are created by the workflow. The original Header Auth workflow remains the optional path that uses a dedicated Apify API token and a pre-created sheet.
- **Is a one-click or two-click official template available?** No. The official n8n template is still pending human review; there is no public template ID or URL yet. Do not expect a click-to-run setup. Account connection and per-node credential confirmation remain required.
- **Where do keys and Google access live?** In your n8n credentials. Both workflow JSON files and the repository contain no token, account name, or spreadsheet ID. MEKA does not receive access to your Google credentials.
- **Is it free?** The example code is MIT licensed, but Apify and n8n may charge for their services. Check current [Actor pricing](https://apify.com/meka.im/linkedin-jobs-scraper) and [n8n pricing](https://n8n.io/pricing/).

## Documentation

- [Cloud auto-setup guide](docs/cloud-setup.md): managed OAuth, automatic spreadsheet/header setup, persistence, recovery, and troubleshooting.
- [Cloud auto-setup acceptance](validation/2026-10-25/cloud-auto-setup-acceptance.json): sanitized n8n Cloud 2.45.3 Experimental OAuth and two-run evidence.
- [Setup guide](docs/setup.md): one-command API and local n8n startup, original Header Auth import, credentials, sheet creation, test, and troubleshooting.
- [Technical reference](docs/reference.md): request sequence, polling, result semantics, failures, security, and tests.
- [Acceptance notes](docs/acceptance.md): local and n8n Cloud evidence, limits, and dated measurement links.
- [n8n template submission notes](docs/n8n-template-submission.md): maintainer copy for Creator submission, review, and release gating.
- [Cloud auto-setup workflow JSON](n8n/linkedin-jobs-cloud.json): inactive, credential-free OAuth import with automatic sheet bootstrap.
- [Workflow JSON](n8n/linkedin-jobs-to-google-sheets.json): inactive, credential-free n8n import.
- [Template submission variant](n8n/linkedin-jobs-to-google-sheets-template.json): the same executable workflow with the review-ready title and expanded setup sticky.
- [Repository tests](tests/): offline mocks for the API examples and embedded n8n Code nodes.

<p align="center">
  Built by <a href="https://meka.im/tools/linkedin-jobs">MEKA</a> &middot;
  <a href="https://github.com/meka-im/linkedin-jobs-scraper-examples">Official repository</a> &middot;
  <a href="https://github.com/meka-im/linkedin-jobs-scraper-examples/issues">Issues</a> &middot;
  <a href="LICENSE">MIT License</a>
</p>
