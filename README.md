# LinkedIn Jobs to Google Sheets with n8n

Runnable examples for finding recent public LinkedIn jobs with the [MEKA LinkedIn Jobs Scraper](https://apify.com/meka.im/linkedin-jobs-scraper), then storing only newly seen jobs in Google Sheets.

Use the n8n workflow for a daily sheet, or start with the JavaScript, Python, or cURL API example. All four use built-in runtime features: the API examples have no package dependencies, and the workflow uses built-in n8n nodes.

**[Download the n8n workflow](n8n/linkedin-jobs-to-google-sheets.json)** · **[Run on Apify](https://apify.com/meka.im/linkedin-jobs-scraper)**

> **Live validation:** Two consecutive n8n 2.44.6 to Google Sheets acceptance runs passed on 2026-10-25 with distinct live Actor runs. See the [acceptance notes](docs/acceptance.md) and [sanitized measurements](validation/2026-10-25/n8n-sheets-acceptance.json).

## What is included

- `n8n/linkedin-jobs-to-google-sheets.json`: inactive n8n workflow with a manual trigger and a daily 08:00 UTC schedule.
- `examples/input.json`: one small Actor input used by every API example.
- `examples/javascript.mjs`: Node.js 22+ example using built-in `fetch`.
- `examples/python.py`: Python 3.10+ standard-library example.
- `examples/curl.sh`: cURL example using Python only for JSON handling.
- `sheets/jobs-header.csv`: the exact Google Sheets header expected by the workflow.
- `tests/`: offline Code-node, export-security, and mock API tests.
- `docs/acceptance.md`: how to read and maintain the live acceptance evidence.
- `validation/`: dated, sanitized measurements for completed acceptance runs.

See the [Actor page](https://apify.com/meka.im/linkedin-jobs-scraper) or [MEKA API directory](https://meka.im/apis/linkedin-jobs) for the current Actor details and pricing.

## Quick start with the API

Clone the official examples repository and move into its root directory:

```bash
git clone https://github.com/meka-im/linkedin-jobs-scraper-examples.git
cd linkedin-jobs-scraper-examples
```

Create an Apify API token and export it without putting it in a URL or command output:

```bash
export APIFY_TOKEN='<your-token>'
```

Run any example from the repository root. Each command reads `examples/input.json` and writes the Dataset items to `jobs.json`.

```bash
node examples/javascript.mjs examples/input.json jobs.json
python3 examples/python.py examples/input.json jobs.json
bash examples/curl.sh examples/input.json jobs.json
```

The scripts send `Authorization: Bearer $APIFY_TOKEN`. They do not place the token in a query string or print it. `curl.sh` requires `curl` and Python 3.10+; the other examples use only their language standard library.

The sample runs one structured search for `software engineer` in `London, United Kingdom`, limited to jobs posted in the past week. Change `examples/input.json` to use another search.

## Happy-path request sequence

Each API example follows the same sequence:

1. Send one `POST` to start `meka.im~linkedin-jobs-scraper` with `memory=512`, `timeout=300`, `maxTotalChargeUsd=0.05`, and `waitForFinish=60`.
2. Poll the started run at most six times while its status is `READY` or `RUNNING`. The start `POST` is never retried automatically, which avoids accidentally starting and charging for another run.
3. Accept only `SUCCEEDED`. `FAILED`, `TIMED-OUT`, and `ABORTED` fail explicitly.
4. Read the run's `OUTPUT` summary before the Dataset.
5. Fail if `failedSearches > 0`. Mark `failedJobDetails > 0`, `failedCompanies > 0`, or `stoppedByBudget: true` as partial coverage.
6. For a successful run with no failed searches, fetch the Dataset with `format=json`, `clean=true`, and the requested `count`, then validate that every item has a numeric `id`, a non-empty `title`, and a public LinkedIn job `link`.

A clean empty Dataset is a successful zero-item result for that fetched batch; it does not imply the search covered every matching public job. An empty Dataset is not treated as clean when the Actor summary reports failed searches, failed details, failed companies, or a budget stop.

If polling reaches its limit or deadline, the error includes the run ID so the started run can be inspected in Apify. A network failure before the run ID is received cannot return an ID that was never received.

## Import the n8n workflow

1. Create a Google Sheets spreadsheet and a worksheet named `Jobs`.
2. Copy row 1 from `sheets/jobs-header.csv` into the worksheet. Keep these ten columns in order:

   ```text
   id,title,company,location,postedAt,url,salary,employmentType,seniority,firstSeenAt
   ```

3. In n8n, choose **Import from File** and import `n8n/linkedin-jobs-to-google-sheets.json`. This is a configurable workflow template, not a one-click hosted automation; complete the credential, sheet, and search settings before running it.
4. Create an **HTTP Header Auth** credential. Set the header name to `Authorization` and the value to `Bearer <APIFY_TOKEN>`. Select this credential on all four Apify HTTP Request nodes: **Start Actor**, **Poll Actor Run**, **Get Run Output**, and **Get Dataset Items**.
5. Create or select a **Google Sheets OAuth2** credential. Select the same Google credential on **Read Existing Jobs** and **Append Rows**.
6. Open **Search settings**. Enter the spreadsheet document ID in `sheetId`, keep `sheetName` set to `Jobs`, and adjust the keywords, location, date window, result limit, and spending cap.
7. Run the workflow manually and inspect both n8n and the sheet.
8. Activate the workflow only after the manual test succeeds and you have chosen the intended schedule.

The exported workflow is inactive and contains no credential ID, token, account name, or spreadsheet ID.

### Schedule and timezone

The included Schedule Trigger runs daily at **08:00 UTC**. Change the workflow timezone or trigger hour if that is not the local time you want. Merely importing the workflow does not start scheduled paid runs.

### Deduplication

The workflow searches `pastWeek` so consecutive daily runs overlap. It reads the existing sheet, compares the Actor's `id` values, deduplicates within the current batch, and appends only unseen jobs. Existing rows are not updated, so `firstSeenAt` keeps the date when this workflow first inserted the job.

Use one workflow and one `Jobs` sheet per initial deployment. Do not run multiple workflows against the same sheet at the same time: separate read-then-append executions can race and append the same unseen IDs. This example is intended for serial, modest-volume use.

The Read node has **Always Output Data** enabled, so an empty data area still reaches the deduplication Code node. A truly empty output placeholder is ignored. Any non-empty existing row without an `id` fails with a clear error instead of being treated as an empty sheet. The Google Sheets append node uses a fixed resource-mapper schema for all ten required headers, so a renamed or missing required header is rejected before rows are written. Keep the recommended order when creating a new sheet; the workflow does not rely on ordering for deduplication or row mapping.

### Result semantics

The Actor writes an `OUTPUT` summary for each run. The workflow reads it before accepting any Dataset items:

- Any failed search fails the workflow. This template defaults to one search, so a partial search is not reported as a clean zero-new result.
- Failed job details, failed company enrichment, or a budget stop produce a partial warning. A run can succeed at the API level while still delivering fewer jobs than requested.
- Only a run with zero failed searches and no partial-coverage indicators can finish as a complete run. A clean empty Dataset is then a normal zero-new result for that fetched batch, without a claim of complete market coverage.

`count` and `limitPerSource` are caps, not a promise of total market coverage. Search rankings, public availability, enrichment failures, and the spending cap can reduce the number of delivered jobs. For broad coverage, use smaller, targeted searches and a deliberate higher budget rather than assuming one query is exhaustive.

## Output columns

The workflow writes these fields:

| Column | Source |
| --- | --- |
| `id` | Public LinkedIn job ID |
| `title` | Job title |
| `company` | Public company name when available |
| `location` | Public location when available |
| `postedAt` | Public posting date when available |
| `url` | Public LinkedIn job URL |
| `salary` | Public salary text when available |
| `employmentType` | Public employment type when available |
| `seniority` | Public seniority when available |
| `firstSeenAt` | ISO timestamp when this workflow first wrote the row |

Missing optional Actor values are stored as empty strings. The append node uses `RAW` cell input so titles, salaries, and other text are not interpreted as formulas.

## Failure behavior

- A start request, status poll, `OUTPUT` request, Dataset request, sheet read, or sheet append that returns an HTTP/API error fails the n8n execution. Failed operations are not counted as zero-new results.
- `READY` and `RUNNING` continue through a bounded poll loop. The loop ends explicitly when its poll count or deadline is exhausted and includes the run ID in the error.
- An incorrect or missing sheet schema fails at the append node before writing rows.
- A successful Actor run with failed searches fails the workflow before Dataset processing.

## Development tests

Run the offline suite:

```bash
npm test
```

This requires Node.js 22+ and Python 3.10+ and starts loopback-only mock HTTP servers. It does not call Apify or Google. The suite directly executes the JavaScript embedded in the exported n8n Code nodes with mocked n8n inputs, validates the workflow export for embedded credentials and unsafe retry settings, checks the sample request sequence, and verifies that invalid input makes no start `POST`.

`tests/fixtures/n8n-code-smoke.workflow.json` is a credential-free fixture for running the actual embedded Code nodes in an n8n instance. Its expected result after a separate n8n execution is `status: "passed"`, `pollCount: 2`, `splitItemCount: 2`, and `urlGlobalType: "undefined"`; the last value records the n8n task sandbox behavior that the embedded validators are written around. A VM test is not a substitute for that real-engine run.

Rebuild the exported workflow and smoke fixture after editing `n8n/code/`:

```bash
npm run build:workflow
```

## Scope and security

This initial template is not designed for high concurrency, full-market coverage, or multi-writer coordination. It does not use an LLM, send social messages, or modify the Actor. Keep API and OAuth tokens in n8n credentials; do not commit `.env`, `jobs.json`, credential exports, or execution payloads containing private data.

The workflow and examples use public job data. Use them in accordance with applicable laws and LinkedIn's terms.

## License

MIT. See `LICENSE`.
