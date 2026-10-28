# MEKA n8n Cloud installer

The installer creates one inactive **MEKA LinkedIn Jobs** workflow through n8n's
official MCP server. It reuses the Cloud auto-setup graph that was accepted on
n8n Cloud 2.45.3 Experimental, including automatic spreadsheet bootstrap,
incremental deduplication, the Actor spending cap, and the ten-column `Jobs`
table.

The live entry is the
**[MEKA n8n hub installer](https://meka.im/n8n/linkedin-jobs-to-google-sheets)**.
Its [production acceptance](../validation/2026-10-26/n8n-hub-production-acceptance.json)
records OAuth in a controlled preview and on the production domain, one
inactive workflow creation in each environment, independent UI export review,
and the public relay boundary. It did not run the Actor, read or write a
Google Sheet, or publish the schedule. The earlier
[hosted acceptance](../validation/2026-10-26/cloud-installer-hosted-acceptance.json)
covers the previous independent hostname and remains historical.

The reliability-onboarding revision adds real account checks, explicit bounded
execution, strict Sheet readback, and execution-response sanitization. The
[sanitized 2026-10-27 acceptance evidence](../validation/2026-10-27/meka-n8n-onboarding-acceptance-safe.json)
records three explicitly confirmed paid runs. The frozen predecessor completed
in 23.138 seconds with 10 fetched jobs, 10 appended rows, complete coverage, no
failed counters, and a separate browser comparison of all 110 header-and-row
cells against the Google API result. It executed **Read Written Jobs** once per
appended item and produced ten identical readback items, so the final artifact
adds `executeOnce` and does not inherit that pass.

The final artifact's second run completed in 17.362 seconds and saved three
jobs, but seven job-detail retrievals failed upstream. Its write/readback
evidence passed for those rows and the UI correctly remained amber **needs
attention**.

A separately authorized third run supplied the complete pass. The same
inactive workflow and graph stayed unchanged. It completed in 15.494 seconds
with 10 fetched jobs, seven new and appended rows, three existing rows skipped,
complete coverage, zero failed searches/details/companies, no budget stop, and
the manual guard fixed to 10 jobs, USD 0.05, and no company enrichment. Its
single readback call completed in 287 milliseconds. Independent Google Sheets
UI comparison matched all 110 cells, found 10 unique IDs and every
`firstSeenAt`, and confirmed the prior three-row snapshot's 40 cells remained
unchanged. The UI showed green **Test passed** only after this verified result;
the execution link opened the recorded execution. The runtime is a one-run
snapshot, not a performance promise.

## Start here

1. In your n8n Cloud workspace, enable **Settings → MCP** and connect your own
   Apify OAuth and Google Sheets OAuth credentials.
2. In the Apify credential, allow HTTP Request domain `api.apify.com`. In the
   Google credential, allow
   `www.googleapis.com,sheets.googleapis.com`. Keep **All** unselected.
3. Open the [MEKA n8n hub installer](https://meka.im/n8n/linkedin-jobs-to-google-sheets),
   enter the workspace,
   review and authorize `workflow:read`, `workflow:write`, `credential:read`,
   `workflow:execute`, and `execution:read`, then choose one credential of each
   type and your search settings.
4. Click the explicit account-check button. Both the Apify API identity check
   and the Google read probe must pass before installation is enabled.
5. Click **Install inactive workflow** once. Success is
   **Installed · Test required**; the structure-only graph readback is not
   connection or execution proof.
6. When ready, tick the bounded-test confirmation and run the small test once.
   Green **Test passed** requires matched execution evidence and independent
   Sheet row verification.

The resulting workflow is inactive. Installation does not run the paid Actor,
create a spreadsheet, publish, or activate the schedule. The user-confirmed test
may create or reuse the spreadsheet and call Apify.

## What it does

The browser asks for:

- The exact `https://<workspace>.app.n8n.cloud` address.
- One existing Apify OAuth credential.
- One existing Google Sheets OAuth credential.
- Keywords and location, plus optional date, limit, budget, enrichment, and
  spreadsheet title settings.
- A workflow name beginning with `MEKA`. The installer appends a short unique
  marker to make interrupted-request recovery unambiguous.

It then:

1. Registers a public OAuth client with the workspace through dynamic client
   registration.
2. Uses Authorization Code with PKCE S256 in the browser.
3. Requests the five exact scopes listed above. These scopes grant broad
   workspace capabilities, so the product enforces a narrower allowlist for
   tools, arguments, workflow identity, execution mode, and response data.
4. Lists only the credential metadata needed to choose one credential of each
   required type.
5. Creates or safely reuses one uniquely named inactive six-node account-check
   workflow. Its fixed GET requests use the selected Apify and Google
   credentials and return only safe service statuses.
6. Renders the fixed 42-node SDK workflow template with the selected values and
   15 credential IDs, then calls `validate_workflow` before creation.
7. Calls `create_workflow_from_code` once and records `created-unverified`
   before attempting readback. It verifies 40 connections, all node parameters
   and execution options, UTC settings, `active=false`, the workflow version,
   and `availableInMCP=true`.
8. Shows amber **Installed · Test required**. A missing credential reference in
   the details response is shown as unavailable rather than treated as proof
   that the binding failed.
9. On explicit confirmation, executes only the reviewed inactive workflow with
   the Manual Trigger. It polls that same execution ID, rechecks the workflow
   version, rejects pinned or unknown execution data, and validates the
   sanitized summary plus actual Sheet readback.

The installer never calls `test_workflow`, publish, archive, delete,
schedule-activation, or a generic workflow-update tool. It never executes
automatically and never retries an ambiguous paid execution.

Every Manual Trigger run in the Cloud workflow is limited to 10 fetched jobs, a
positive USD budget no greater than 1, and `scrapeCompany=false`. The USD 1
setting is a maximum, not a fixed charge. The saved
schedule retains the user's requested limit and budget for a later activation
the user performs personally. n8n Code nodes use `$execution.mode` values
`test` for manual runs and `production` for scheduled runs; a missing or
unknown mode fails closed or receives the conservative manual clamp.

## n8n prerequisites

### 1. Enable MCP access

An n8n workspace administrator must enable MCP access in
**Settings → MCP** (`https://<workspace>.app.n8n.cloud/settings/mcp`).
The installer cannot enable it.

If the protected-resource metadata is unavailable, the installer stops before
authorization and links to that settings page.

### 2. Allow the installer callback

If the n8n workspace configures a non-empty OAuth callback allowlist, the
installer callback must exactly match one of its allowed URIs. A workspace with
an empty allowlist does not impose that extra match. A hosted installer still
needs a redirect URI that the workspace administrator is willing to authorize.

The production callback is
`https://meka.im/n8n/oauth/callback`. The callback removes the OAuth `code` and
`state` from the visible URL after returning to the installer.

For local development, the callback is a loopback URL such as
`http://127.0.0.1:4173/`. Loopback redirect URIs use the normal browser OAuth
callback model.

### 3. Install the Apify node package if needed

The workflow uses the official verified `@apify/n8n-nodes-apify` package
`0.8.1` so its HTTP Request nodes can select `apifyOAuth2Api`.

If that credential type is absent, install the exact package from n8n Community
Nodes after reviewing its registry source, then refresh the installer. The
installer never silently installs a package and does not request the
`communityPackage:install` scope by default.

### 4. Connect the credential types

Connect one **Apify OAuth2** credential. The current official credential
requests Apify `profile` and `full_api_access`, which gives n8n full API access
to the selected Apify account. Users who need a smaller permission surface can
use the original HTTP Header Auth workflow with a dedicated token.

Connect one **Google Sheets OAuth2** credential. The installer does not export,
read, or change either credential's secret.

Both credentials must allow use in HTTP Request nodes. In each credential's
**Connection → Allowed HTTP Request Domains**, choose **Specific Domains**:

- Apify: `api.apify.com`
- Google: `www.googleapis.com,sheets.googleapis.com`

Do not choose **All**. MCP can see credential names, IDs, and types, but it
cannot inspect the secret or domain restriction. The installer cannot repair a
domain restriction, so a later Manual Trigger will stop clearly if one is
missing.

## OAuth and MCP endpoints

For a validated workspace origin, the installer uses:

```text
MCP resource:
https://<workspace>.app.n8n.cloud/mcp-server/http

Protected-resource metadata:
https://<workspace>.app.n8n.cloud/.well-known/oauth-protected-resource/mcp-server/http

Authorization-server metadata:
https://<workspace>.app.n8n.cloud/.well-known/oauth-authorization-server
```

The metadata and every OAuth endpoint must remain on that exact origin.
Authorization servers, token endpoints, and issuers from other origins are
rejected. The access token is sent only in the `Authorization` header to the
fixed MCP path. On a hosted deployment it passes transiently through the
same-origin MEKA installer relay described below. The browser and relay do not
place it in a URL, DOM text, local storage, or long-term session storage, and
the installer application does not log it.

The relay handles MCP calls during installation only and does not persist the
n8n access token. Apify and Google OAuth secrets remain in the user's n8n
credentials; the installer reads only credential metadata and does not export
or change those secrets.

The OAuth state is random and single use with a ten-minute lifetime. The PKCE
verifier, state, workspace origin, registration metadata, and redirect URI are
temporarily held in `sessionStorage` only long enough to survive the redirect.
They are removed before the callback finishes. Callback query parameters are
removed immediately with `history.replaceState`.

## Browser CORS boundary

n8n's OAuth metadata, registration, and token endpoints answer cross-origin
preflights. In the inspected Cloud build, the MCP endpoint responds to
`OPTIONS` but omits the CORS response headers. OAuth can therefore remain a
direct browser-to-n8n exchange, while MCP needs a same-origin relay.

A static GitHub Pages deployment can finish OAuth and then fail clearly at the
first MCP request. It is not a viable public hosted path for this flow. The
installer does not use `no-cors`, put a token in a URL, disable browser
security, or claim success when MCP is unavailable.

### Hosted Cloudflare Worker

The Worker source is under `installer/worker/`, with
`installer/wrangler.toml` naming the independent service
`meka-n8n-installer`. The public installer runs on the
[MEKA n8n hub](https://meka.im/n8n/linkedin-jobs-to-google-sheets). The
production website reaches the backend through its `N8N_INSTALLER` service
binding: `/api/n8n/health` maps to `/api/health`, and `/api/n8n/mcp` maps to
`/api/mcp`. The repository's cutover configuration removes the Worker's public
route: `routes = []`, `workers_dev = false`, and preview URLs are disabled.
The release sequence is to merge the public-repository change, deploy the
`routes = []` configuration, and then verify that the former custom domain has
been removed. Installation acceptance records are point-in-time snapshots and
do not track later route operations.

`routes = []` controls the Worker's route configuration; it does not by itself
guarantee that an existing Cloudflare Workers Custom Domain has been removed.
After each cutover deployment, the release owner must inspect Cloudflare
Domains or use the official API for the exact service, explicitly remove any
remaining custom-domain binding, and verify the hostname no longer resolves.
This operation does not add a replacement public hostname; the MEKA site keeps
using the `N8N_INSTALLER` service binding. The completed cutover is recorded in
the [sanitized cutover evidence](../validation/2026-10-26/n8n-hub-cutover-complete.json).

The Worker package still contains the installer's static assets and exposes
only these internal API routes:

- `GET /api/health`
- `POST /api/mcp`, plus same-origin `OPTIONS`

The page still sends OAuth discovery, registration, authorization, and token
requests directly to the selected n8n Cloud origin. Only MCP JSON-RPC requests
use the public `/api/n8n/mcp` route, which the website maps to the Worker's
`/api/mcp` route. The Worker accepts a canonical
`https://<workspace>.app.n8n.cloud` origin in `X-MEKA-Target-Origin`, constructs
the fixed `/mcp-server/http` URL itself, and never accepts a caller-supplied
URL or path. The access token remains in browser memory and is forwarded only
as the upstream `Authorization` header. The relay does not persist or log the
token or request body.

The relay enforces:

- Same-origin `Host` and `Origin` checks.
- A native Cloudflare rate-limit binding in installer-specific namespace
  `2601026`, with 60 POST requests per minute per client IP and an
  `meka-n8n-installer:` key prefix. A missing or failing binding fails closed;
  a refused request stops before parsing or forwarding the RPC body.
- HTTPS, a single-label `*.app.n8n.cloud` workspace host, no port, userinfo,
  query, or fragment.
- A 45-second upstream timeout and manual redirect refusal.
- A 320 KB streaming request limit and a 5 MB streaming response limit;
  over-limit bodies are cancelled.
- A JSON-only, non-batch JSON-RPC envelope.
- Discovery, initialization, `notifications/initialized`, and `tools/list`.
- Tool calls for only `list_credentials`, `validate_workflow`,
  `create_workflow_from_code`, `get_workflow_details`, the bounded
  `search_workflows` recovery lookup, `execute_workflow`, and
  `get_workflow_execution`.
- Exact argument checks for every allowed tool. Execution permits only the
  `Manual Trigger`; detailed execution reads require the complete reviewed
  node set, `includeData=true`, and `truncateData=1`.
- No `test_workflow`, publish, archive, delete, schedule activation,
  credential-secret access, or community-package installation.
- Two-stage execution-response sanitation. The backend accepts only the raw n8n
  execution shape and emits a fixed metadata/summary whitelist plus exact
  `resultData.pinData` state. The website validates that already sanitized shape
  again and emits a fresh allowlisted object.
- No cookies or private upstream response headers forwarded to the browser.

Malformed UTF-8, JSON, or SSE, unknown fields, raw node/context data, upstream
errors, stack traces, and forged sanitization markers fail closed. Raw upstream
expression errors can contain node input data, so the Worker neither forwards
nor logs them.

The Worker runs first for static asset requests so it can attach
`Content-Security-Policy` with `frame-ancestors 'none'`, `X-Frame-Options:
DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a
restrictive permissions policy. The HTML also retains the enforceable subset
of the CSP as a defense-in-depth fallback. Wrangler observability is explicitly
disabled. The Worker application does not log request URLs, OAuth callback
parameters, tokens, request bodies, credentials, or upstream responses.

The relay is same-origin with the installer, so the browser uses it
automatically when the public health route reports a relay. A same-origin page
cannot isolate its JavaScript from the token it uses for any MCP request; the
deployment boundary is therefore the reviewed static bundle, restrictive CSP,
no third-party scripts or analytics, and the fixed relay policy.

Build and inspect the deployable output without deploying:

```bash
npm --prefix installer ci --ignore-scripts
npm --prefix installer run build:public
npm --prefix installer run worker:check
```

Every Wrangler command in `installer/package.json` passes
`-c wrangler.toml`. The static build uses an explicit allowlist: HTML, CSS,
browser JavaScript, generated browser modules, and the unchanged four-square
MEKA banner. It excludes the Node server, Worker source, tests, docs,
`node_modules`, package locks, and Wrangler configuration.

The active public site uses the private service binding described above. After
merging the public-repository change, the release owner deploys this
`routes = []` configuration and verifies that the former custom domain is
removed. Future deployments and route changes remain release-owner actions
after review. The deployed bundle has no analytics, third-party scripts,
persistent browser token storage, or secret environment variables.

### Loopback development path

The included local server provides a same-origin, loopback-only MCP transport.
It is for local development and evaluation.

```bash
npm --prefix installer ci --ignore-scripts
npm --prefix installer run build
npm run installer:start
```

Open `http://127.0.0.1:4173/`. Use `PORT` to select another local port.

The relay:

- Binds only to `127.0.0.1`.
- Accepts only a strict `*.app.n8n.cloud` target origin and the fixed MCP path.
- Performs a best-effort DNS precheck and rejects unsafe addresses. This does
  not eliminate a DNS re-resolution race and is not a substitute for a
  separately hardened production relay.
- Rejects redirects and MCP batch requests.
- Permits only discovery, initialization, `tools/list`, and the installer's
  tool calls: `list_credentials`, `validate_workflow`,
  `create_workflow_from_code`, `get_workflow_details`, the bounded
  `search_workflows` recovery lookup, explicit Manual Trigger execution, and
  bounded execution reads.
- Never logs credentials, OAuth tokens, request bodies, or upstream responses.
- Keeps the OAuth token in browser memory and sends it to the local relay only
  in the authorization header for the duration of an installation.

The live hosted installer is the
[MEKA n8n hub](https://meka.im/n8n/linkedin-jobs-to-google-sheets). The loopback
server is a separate development path and does not receive the production
hostname.

## Workflow behavior

The fixed source is
[`n8n/linkedin-jobs-cloud.json`](../n8n/linkedin-jobs-cloud.json), SHA-256:

```text
26647c7e5742287cc2e797351334f3e09689707b552d3d5fb6142a9a876f5241
```

The build script uses `@n8n/workflow-sdk` 0.37.2 to generate a fixed SDK
template and an expected graph manifest. It fails the build if roundtrip
validation changes the 42-node graph, 40 connection entries, settings, node
types, parameters, or the 4 Apify plus 11 Google credential bindings.

At runtime, unique sentinel strings and numbers are replaced with escaped
JSON/JavaScript literals. The browser does not load the workflow SDK, execute
untrusted code, or parse a user-supplied workflow.

The workflow is created in the user's personal project because the installer
does not request a project ID. n8n sets `availableInMCP=true`; this makes the
created copy available through the same MCP integration. The installer does
not enumerate unrelated workflows.

The first user-confirmed Manual Trigger creates or reuses one spreadsheet tagged
with the new workflow ID. The Google bootstrap finishes before the charged
Actor start. The summary node reads the written rows back and checks all ten
fields, `firstSeenAt`, ID uniqueness, and that prior rows are unchanged. Zero
new rows, partial/budget-stopped runs, and write-readback failures remain
unverified. Later runs reuse the same spreadsheet and preserve existing rows and
`firstSeenAt` values.

The workflow settings declare `UTC`, and the schedule is 08:00. It remains
inactive. Review what 08:00 means in the n8n UI before publishing it.

## Credential verification boundary

The generated code contains all 15 explicit credential references. Before
creation, the installer checks that the rendered template still has four
`apifyOAuth2Api` and eleven `googleSheetsOAuth2Api` bindings. n8n then validates
that the current user can reach those IDs and that the node configuration uses
matching credential types.

The official `get_workflow_details` response intentionally strips credential
references from `workflow.nodes`. After creation, the installer therefore
verifies the graph, parameters, connections, settings, and inactive state. It
does not claim that the readback exposed the 15 IDs. If n8n exposes all
references, their exact type, ID, and name are checked; if it exposes only some,
the readback is treated as unavailable rather than a successful binding test.

The read-only account check separately proves Apify account/API access and
Google Drive metadata read access. It does not prove that the workflow-created
Sheet will be writable. Only the explicit test and its independent row readback
can provide that end-to-end evidence.

## Failure and recovery

Validation failures stop before creation.

The create button and a synchronous in-flight guard block a second submit while
the request is active. A create request is never retried automatically. Before
the create call, the installer stores a recovery marker containing the unique
workflow name, workspace origin, status, and any known workflow ID. It does not
store credential IDs or plaintext search settings. It stores a randomly salted
SHA-256 digest of the seven submitted search fields. After a reload,
reconnecting the same workspace restores the Check installation path and
recomputes that digest from the n8n readback before success is shown.

Immediately after a create response, the marker is saved as
`created-unverified`. A reload or readback failure therefore still blocks a
second create. Known execution IDs are resumed; an ambiguous execution with no
ID blocks another paid run and links the user to n8n for manual execution
inspection. A changed credential binding cannot silently replace an unresolved
helper create or execution.

The current recovery key is `meka.n8n.hub.onboarding.v2`. An old unresolved v1
marker is migrated into a manual-review block and retained as a create guard;
the installer does not verify a 41-node historical graph against the current
42-node manifest or discard the evidence.

The recovery action accepts a workflow ID or searches for the exact unique name
generated for that attempt. Zero matches or multiple matches stop without
creating or selecting another workflow.

## Local installer acceptance

The sanitized record of the local browser acceptance performed on 2026-10-26 is
[`validation/2026-10-26/cloud-installer-local-acceptance.json`](../validation/2026-10-26/cloud-installer-local-acceptance.json).
It records the three requested OAuth scopes, unique credential selection,
validate-before-create, successful readback of the 41-node and 39-connection
inactive UTC workflow, the UI export's four Apify and ten Google credential
bindings, and two capped Manual Trigger runs with independent Sheet readback.

The record deliberately excludes workspace, account, workflow, execution, run,
dataset, credential, and spreadsheet identifiers. It was recorded while the
Worker was not yet hosted, so its historical publication fields remain false.
It includes the two capped Manual Trigger runs with their independently read
spreadsheet results.

## Installer acceptance records

The production installation snapshot is
[`validation/2026-10-26/n8n-hub-production-acceptance.json`](../validation/2026-10-26/n8n-hub-production-acceptance.json).
It records the live MEKA n8n hub entry, controlled-preview and production
OAuth, successful inactive-workflow creation and readback, independent UI
export comparison, relay checks, and zero Actor or Google Sheet activity during
this installation acceptance. Its `cutoverState` reflects the deployment route
state when measured; it is a dated snapshot, not a live status indicator.

The earlier
[`validation/2026-10-26/cloud-installer-hosted-acceptance.json`](../validation/2026-10-26/cloud-installer-hosted-acceptance.json)
is the historical acceptance for the previous independent hostname. It records
that deployment, public endpoint and security-header smoke checks, negative
relay tests, the three OAuth scopes, successful creation of one inactive
41-node/39-connection UTC workflow, independently verified exports with four
Apify and ten Google credential bindings, and zero paid Actor runs.

The two live manual Actor runs linked from that evidence were performed on the local
installer path, not through the hosted service. Public evidence records no
workspace, account, workflow, run, dataset, credential, or spreadsheet IDs.

Those records describe the previous three-scope, graph-only onboarding flow.
They do not verify this revision's five scopes, account helper, execution
sanitization, pin evidence, manual-run clamp, or end-to-end Sheet readback.

## Offline verification

Run the installer-focused tests:

```bash
npm run test:installer
```

The suite covers strict workspace and OAuth origin checks, PKCE, one-time
state, callback expiry and replay, token placement, MCP JSON/SSE parsing,
protocol fallback, tool pagination, credential selection, all 15 bindings,
input escaping, validate-before-create ordering, create-without-retry,
unknown-result recovery, graph readback, protected artifact hashes, and relay
method/tool restrictions. Account and execution tests cover the exact
six-node helper, credential and version binding, same-ID resume, resolution of
failed versus unknown checks, finite manual limits, strict summary/counter
coverage, pinned and unknown evidence, zero-new rows, and Sheet write/readback
failures. Cloud tests also prove `$execution.mode='test'` is clamped while
`production` keeps the saved schedule settings. Worker tests also cover
spoofed Host and Origin,
arbitrary target rejection, redirects, request/response streaming limits,
private-header stripping, the public-asset allowlist, security headers,
fail-closed rate limiting, and legacy MCP initialization with both empty `202`
and `204` notification responses. Execution-response tests cover malformed
UTF-8/JSON/SSE and arbitrary-field sentinels so raw data cannot leak.

The loopback server tests skip only when the test sandbox forbids `listen`.
Run them outside that sandbox for final acceptance.

The previous hosted installation path has been exercised separately; see the
dated evidence above. Offline tests remain distinct from any new live result.
The five scopes, disconnected-account blocking, transient Google rate-limit
classification flow, successful two-account check, amber installation state,
and explicitly confirmed bounded paid executions were exercised in the
isolated controlled preview. The
[sanitized 2026-10-27 evidence](../validation/2026-10-27/meka-n8n-onboarding-acceptance-safe.json)
records the frozen predecessor's 10-row result, the final artifact's partial
three-row run, and the final artifact's complete 10-row pass. The complete run
used one readback call, had complete coverage and zero failed counters, matched
all 110 current cells and all 40 cells in the prior snapshot, and showed green
**Test passed** only after verification. The recorded execution link also
opened successfully. The 15.494-second runtime is a point-in-time measurement,
not a performance promise.
