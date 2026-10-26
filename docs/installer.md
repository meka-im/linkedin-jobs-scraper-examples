# MEKA n8n Cloud installer

The installer creates one inactive **MEKA LinkedIn Jobs** workflow through n8n's
official MCP server. It reuses the Cloud auto-setup graph that was accepted on
n8n Cloud 2.45.3 Experimental, including automatic spreadsheet bootstrap,
incremental deduplication, the Actor spending cap, and the ten-column `Jobs`
table.

The hosted entry is **[install.meka.im](https://install.meka.im/)**. Its
deployment and installation-only acceptance are recorded separately from the
two live manual Actor runs. The release owner independently confirmed the
hosted workflow's 14 explicit credential bindings in the n8n UI export without
recording credential IDs in public evidence.

## Start here

1. In your n8n Cloud workspace, enable **Settings → MCP** and connect your own
   Apify OAuth and Google Sheets OAuth credentials.
2. In the Apify credential, allow HTTP Request domain `api.apify.com`. In the
   Google credential, allow
   `www.googleapis.com,sheets.googleapis.com`. Keep **All** unselected.
3. Open [install.meka.im](https://install.meka.im/), enter the workspace,
   authorize `workflow:read`, `workflow:write`, and `credential:read`, then
   choose one credential of each type and your search settings.
4. Click **Install** once and wait for **Installation Verified**. Choose
   **Open in n8n** after the workflow readback passes.

The resulting workflow is inactive. Installation does not run the paid Actor,
create a spreadsheet, publish, or activate the schedule.

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
3. Requests `workflow:read`, `workflow:write`, and `credential:read`.
4. Lists only the credential metadata needed to choose one credential of each
   required type.
5. Renders the fixed SDK workflow template with the selected values and
   credential IDs.
6. Calls `validate_workflow` before any create request.
7. Calls `create_workflow_from_code` once.
8. Reads the created workflow and verifies 41 nodes, 39 connections, core
   parameters, UTC settings, `active=false`, and `availableInMCP=true`.
9. Shows **Open in n8n** only after that verification passes.

The installer does not call `execute_workflow`, `publish_workflow`,
`archive_workflow`, or any delete operation. It does not run the paid Actor.
The Daily Schedule remains inactive.

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
`meka-n8n-installer`. It is deployed at
[install.meka.im](https://install.meka.im/). The custom domain is the only
public route: `workers_dev` and preview URLs are disabled.

The Worker serves the installer's static assets and exposes only two API
routes:

- `GET /api/health`
- `POST /api/mcp`, plus same-origin `OPTIONS`

The page still sends OAuth discovery, registration, authorization, and token
requests directly to the selected n8n Cloud origin. Only MCP JSON-RPC requests
use `/api/mcp`. The Worker accepts a canonical
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
  `create_workflow_from_code`, `get_workflow_details`, and the bounded
  `search_workflows` recovery lookup.
- No `execute_workflow`, `publish_workflow`, archive, delete, credential-secret
  access, or community-package installation.
- No cookies or private upstream response headers forwarded to the browser.

The Worker runs first for static asset requests so it can attach
`Content-Security-Policy` with `frame-ancestors 'none'`, `X-Frame-Options:
DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a
restrictive permissions policy. The HTML also retains the enforceable subset
of the CSP as a defense-in-depth fallback. Wrangler observability is explicitly
disabled. The Worker application does not log request URLs, OAuth callback
parameters, tokens, request bodies, credentials, or upstream responses.

The relay is same-origin with the installer, so the browser uses it
automatically when `/api/health` reports a public relay. A same-origin page
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

The production deployment uses the independent service and custom domain
described above. Future deployments and hostname changes remain release-owner
actions after review. The deployed bundle has no analytics, third-party
scripts, persistent browser token storage, or secret environment variables.

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
  `create_workflow_from_code`, `get_workflow_details`, and the bounded
  `search_workflows` recovery lookup.
- Never logs credentials, OAuth tokens, request bodies, or upstream responses.
- Keeps the OAuth token in browser memory and sends it to the local relay only
  in the authorization header for the duration of an installation.

The hosted Worker remains available at
[install.meka.im](https://install.meka.im/) for normal use. The loopback server
is a separate development path and does not receive the production hostname.

## Workflow behavior

The fixed source is
[`n8n/linkedin-jobs-cloud.json`](../n8n/linkedin-jobs-cloud.json), SHA-256:

```text
fcdb945365562ec97243d353b344ecc67b1a9738c310d15cfe18f130122dd85b
```

The build script uses `@n8n/workflow-sdk` 0.37.2 to generate a fixed SDK
template and an expected graph manifest. It fails the build if roundtrip
validation changes the 41-node graph, 39 connection entries, settings, node
types, parameters, or the 4 Apify plus 10 Google credential bindings.

At runtime, unique sentinel strings and numbers are replaced with escaped
JSON/JavaScript literals. The browser does not load the workflow SDK, execute
untrusted code, or parse a user-supplied workflow.

The workflow is created in the user's personal project because the installer
does not request a project ID. n8n sets `availableInMCP=true`; this makes the
created copy available through the same MCP integration. The installer does
not enumerate unrelated workflows.

The first Manual Trigger creates or reuses one spreadsheet tagged with the new
workflow ID. The Google bootstrap finishes before the charged Actor start.
Later runs reuse the same spreadsheet and preserve existing rows and
`firstSeenAt` values.

The workflow settings declare `UTC`, and the schedule is 08:00. It remains
inactive. Review what 08:00 means in the n8n UI before publishing it.

## Credential verification boundary

The generated code contains all 14 explicit credential references. Before
creation, the installer checks that the rendered template still has four
`apifyOAuth2Api` and ten `googleSheetsOAuth2Api` bindings. n8n then validates
that the current user can reach those IDs and that the node configuration uses
matching credential types.

The official `get_workflow_details` response intentionally strips credential
references from `workflow.nodes`. After creation, the installer therefore
verifies the graph, parameters, connections, settings, and inactive state. It
does not claim that the readback exposed the 14 IDs.

The strongest post-create UI check remains n8n's own private **Export** or
credential-node review in the created workflow.

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

## Hosted installer acceptance

The hosted installation-only record is
[`validation/2026-10-26/cloud-installer-hosted-acceptance.json`](../validation/2026-10-26/cloud-installer-hosted-acceptance.json).
It records the custom-domain deployment, public endpoint and security-header
smoke checks, negative relay tests, the three OAuth scopes, successful creation
of one inactive 41-node/39-connection UTC workflow, independently verified
exports with four Apify and ten Google credential bindings, and zero paid Actor
runs.

The two live manual Actor runs linked from that evidence were performed on the local
installer path, not through the hosted service. Public evidence records no
workspace, account, workflow, run, dataset, credential, or spreadsheet IDs.

## Offline verification

Run the installer-focused tests:

```bash
npm run test:installer
```

The suite covers strict workspace and OAuth origin checks, PKCE, one-time
state, callback expiry and replay, token placement, MCP JSON/SSE parsing,
protocol fallback, tool pagination, credential selection, all 14 bindings,
input escaping, validate-before-create ordering, create-without-retry,
unknown-result recovery, graph readback, protected artifact hashes, and relay
method/tool restrictions. Worker tests also cover spoofed Host and Origin,
arbitrary target rejection, redirects, request/response streaming limits,
private-header stripping, the public-asset allowlist, security headers,
fail-closed rate limiting, and legacy MCP initialization with both empty `202`
and `204` notification responses.

The loopback server tests skip only when the test sandbox forbids `listen`.
Run them outside that sandbox for final acceptance.

The hosted installation path has been exercised separately; see the evidence
section above. Offline tests remain distinct from that live result. A future
deployment should still be checked for OAuth redirect behavior, Worker CORS and
relay limits, credential reachability, workflow readback, and failure messages
before release.
