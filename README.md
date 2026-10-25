<p align="center">
  <img src="assets/banner.svg" width="1200" alt="MEKA banner: New jobs. One clean sheet. A scheduled flow from n8n to MEKA and Google Sheets.">
</p>

<h1 align="center">LinkedIn Jobs to Google Sheets with n8n</h1>

<p align="center">
  Find recent public LinkedIn jobs with MEKA, remove jobs you have already seen, and append the rest to a tidy Google Sheet.
</p>

<p align="center">
  <a href="https://raw.githubusercontent.com/meka-im/linkedin-jobs-scraper-examples/main/n8n/linkedin-jobs-to-google-sheets.json">
    <img src="https://img.shields.io/badge/Get_the_n8n_workflow-075cf5?style=for-the-badge&logo=n8n&logoColor=white" alt="Get the n8n workflow">
  </a>
  <a href="https://sheets.google.com/create">
    <img src="https://img.shields.io/badge/Create_a_Google_Sheet-0f9d58?style=for-the-badge&logo=googlesheets&logoColor=white" alt="Create a Google Sheet">
  </a>
  <a href="https://apify.com/meka.im/linkedin-jobs-scraper">
    <img src="https://img.shields.io/badge/Run_on_Apify-061b37?style=for-the-badge" alt="Run on Apify">
  </a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#api-examples">API examples</a> &middot;
  <a href="#documentation">Documentation</a>
</p>

<p align="center">
  <strong>Import &rarr; connect your accounts &rarr; choose a sheet &rarr; enable.</strong>
  <a href="docs/setup.md">Cloud-first setup guide</a><br>
  <sub>Tested with local n8n 2.44.6.</sub>
</p>

## Why this workflow

- **Daily by default.** A manual trigger makes setup testable; an included Schedule Trigger runs at **08:00 UTC** after you activate the workflow.
- **Incremental by design.** Each run searches a recent window, deduplicates by LinkedIn job `id`, and appends only unseen rows.
- **Stable first-seen data.** Existing rows are not rewritten, so `firstSeenAt` remains the timestamp when that job first entered your sheet.
- **Small dependency surface.** The workflow uses built-in n8n nodes. It uses no LLM and no third-party npm packages.

## How it works

<p align="center">
  <img src="assets/workflow-overview.svg" width="1200" alt="Workflow illustration: schedule, run MEKA, read the Jobs sheet, deduplicate by id, and append new rows.">
</p>

**Schedule -> MEKA -> validate `OUTPUT` -> fetch one batch -> read existing IDs -> append new rows.**

The workflow checks the Actor's `OUTPUT` counters before accepting Dataset items. A clean empty batch means no new IDs were found in that fetched batch; it does not imply full-market coverage.

## Quick start

1. **Import the workflow.** In n8n, choose **Import from URL** and paste the [raw workflow JSON](https://raw.githubusercontent.com/meka-im/linkedin-jobs-scraper-examples/main/n8n/linkedin-jobs-to-google-sheets.json). Alternatively, download the file and choose **Import from File**. Keep it inactive. See [n8n's import guide](https://docs.n8n.io/build/manage-workflows/export-and-import.md).

2. **Connect two accounts.** For Apify, create an **HTTP Header Auth** credential with name `Authorization` and value `Bearer <YOUR_APIFY_TOKEN>`, then select it on **Start Actor**, **Poll Actor Run**, **Get Run Output**, and **Get Dataset Items**. For Google on n8n Cloud, create a **Google Sheets OAuth2** credential, click **Sign in with Google**, and select the same credential on **Read Existing Jobs** and **Append Rows**. Cloud managed OAuth uses your own Google authorization; the workflow contains no token or account ID.

3. **Prepare the sheet and settings.** [Create a blank spreadsheet](https://sheets.google.com/create), rename its worksheet to `Jobs`, and paste the tab-separated header below into cell **A1**. Open **Search settings**, enter the spreadsheet document ID as `sheetId`, keep `sheetName` as `Jobs`, and set your keywords, location, date window, result limit, and spending cap.

4. **Test, inspect, then activate.** Run the workflow manually once and check both the n8n execution and the actual sheet. Only after that succeeds should you choose the intended schedule. The provided schedule is daily at **08:00 UTC**; adjust it if that is not the local time you want.

**Copy this tab-separated header after opening the [TSV file](sheets/jobs-header.tsv):**

```tsv
id	title	company	location	postedAt	url	salary	employmentType	seniority	firstSeenAt
```

Paste it into **A1**. Do not paste separately comma-delimited values into A1: Google Sheets may place that text in one cell. The workflow requires these ten exact header names. This guide uses the worksheet name `Jobs`; another tab name works when `sheetName` in **Search settings** matches it. The order above is recommended, while row mapping and deduplication use the header names.

<details>
<summary><strong>Using self-hosted n8n?</strong></summary>

Self-hosted installations may use a custom Google OAuth2 credential instead of n8n Cloud managed OAuth. Configure the Google Sheets API and Google Drive API, create the required OAuth client in your own Google Cloud project, and complete the provider's security requirements. Do not bypass a Google OAuth warning. The full credential checklist is in [docs/setup.md](docs/setup.md#self-hosted-google-oauth).

</details>

## Deduplication and sheet safety

The workflow searches `pastWeek` so daily runs overlap, reads the current `Jobs` sheet, removes duplicate IDs within the new batch, and appends only IDs that are absent from the sheet. Existing rows are left untouched. Keep one workflow and one sheet writer per deployment; two executions reading and appending at the same time can race and create duplicates.

The append node writes cells as `RAW`, so spreadsheet formulas are not evaluated. A row containing data but no valid `id` stops the execution with an explicit error instead of being treated as empty.

## Output columns

`id`, `title`, `company`, `location`, `postedAt`, `url`, `salary`, `employmentType`, `seniority`, `firstSeenAt`

Missing optional Actor values are stored as empty strings. See [the field-by-field reference](docs/reference.md#output-columns) for sources and behavior.

## Live acceptance evidence

| Run on 2026-10-25 | Fetched | Existing IDs skipped | Appended | Sheet rows |
| --- | ---: | ---: | ---: | ---: |
| First run | 10 | 0 | 10 | 0 -> 10 |
| Second run | 10 | 9 | 1 | 10 -> 11 |

The two complete end-to-end runs used distinct live Actor runs on local n8n 2.44.6. The final sheet had **11 unique IDs and 0 duplicates**. All ten pre-existing rows, including their original `firstSeenAt` values, remained unchanged.

Read the [acceptance notes](docs/acceptance.md) and [sanitized measurements](validation/2026-10-25/n8n-sheets-acceptance.json). These are historical acceptance results, not a guarantee that a later run will append the same number of jobs.

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

- **Does this cover every LinkedIn job in a market?** No. Results are bounded by the Actor input, public availability, search ranking, enrichment outcomes, and spending cap. Use focused searches for broader practical coverage.
- **Is importing the JSON enough?** No. You still supply Apify and Google credentials, create the exact `Jobs` sheet, choose search settings, and test before activation.
- **Where do keys and Google access live?** In your n8n credentials. The [workflow JSON](n8n/linkedin-jobs-to-google-sheets.json) and repository contain no token, account name, or spreadsheet ID. MEKA does not receive access to your Google credentials.
- **Is it free?** The example code is MIT licensed, but Apify and n8n may charge for their services. Check current [Actor pricing](https://apify.com/meka.im/linkedin-jobs-scraper) and [n8n pricing](https://n8n.io/pricing/).

## Documentation

- [Setup guide](docs/setup.md): Cloud-first import, credentials, sheet creation, test, and troubleshooting.
- [Technical reference](docs/reference.md): request sequence, polling, result semantics, failures, security, and tests.
- [Acceptance notes](docs/acceptance.md): evidence scope and maintenance rules.
- [Sanitized acceptance measurements](validation/2026-10-25/n8n-sheets-acceptance.json): machine-readable 2026-10-25 results.
- [Workflow JSON](n8n/linkedin-jobs-to-google-sheets.json): inactive, credential-free n8n import.
- [Repository tests](tests/): offline mocks for the API examples and embedded n8n Code nodes.

The exported workflow SHA-256 is `8823e9720a601683197fff35a30586343f58632515e1854d7f13cd417f2299ac`.

<p align="center">
  Built by <a href="https://meka.im">MEKA</a> &middot;
  <a href="https://github.com/meka-im/linkedin-jobs-scraper-examples">Official repository</a> &middot;
  <a href="https://github.com/meka-im/linkedin-jobs-scraper-examples/issues">Issues</a> &middot;
  <a href="LICENSE">MIT License</a>
</p>
