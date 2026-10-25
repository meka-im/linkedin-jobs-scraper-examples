#!/usr/bin/env bash
set -euo pipefail

input_path="${1:-examples/input.json}"
output_path="${2:-jobs.json}"
api_base="https://api.apify.com"
actor_id="meka.im~linkedin-jobs-scraper"

if [[ -z "${APIFY_TOKEN:-}" ]]; then
  echo "Set APIFY_TOKEN in your environment" >&2
  exit 1
fi

# Validate before the POST so a bad local input cannot start a charged run.
limit="$(
  python3 - "$input_path" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
if not isinstance(payload, dict):
    raise SystemExit("Input must be a JSON object")
count = payload.get("count")
limit = payload.get("limitPerSource")
if isinstance(count, bool) or not isinstance(count, int) or count < 1:
    raise SystemExit("input.count must be a positive integer")
if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
    raise SystemExit("input.limitPerSource must be a positive integer")
keywords = payload.get("keywords")
urls = payload.get("urls")
companies = payload.get("companyIds")
if not (
    isinstance(keywords, str) and keywords.strip()
) and not (
    isinstance(urls, list) and urls
) and not (
    isinstance(companies, list) and companies
):
    raise SystemExit("Input must include keywords, urls, or companyIds")
if payload.get("datePosted") is not None and payload["datePosted"] not in {
    "anyTime",
    "past24Hours",
    "pastWeek",
    "pastMonth",
}:
    raise SystemExit("input.datePosted has an unsupported value")
if payload.get("scrapeCompany") is not None and not isinstance(
    payload["scrapeCompany"], bool
):
    raise SystemExit("input.scrapeCompany must be a boolean")
print(count)
PY
)"

start_response="$(mktemp)"
poll_response="$(mktemp)"
output_response="$(mktemp)"
dataset_response="$(mktemp)"
trap 'rm -f "$start_response" "$poll_response" "$output_response" "$dataset_response"' EXIT

# The POST is deliberately performed once. A retry could start another charged run.
curl --silent --show-error --fail-with-body --max-time 70 \
  --request POST \
  --header "Authorization: Bearer ${APIFY_TOKEN}" \
  --header "Accept: application/json" \
  --header "Content-Type: application/json" \
  --data-binary "@${input_path}" \
  "${api_base}/v2/acts/${actor_id}/runs?memory=512&timeout=300&maxTotalChargeUsd=0.05&waitForFinish=60" \
  --output "$start_response"

parse_run() {
  local response_file="$1"
  python3 - "$response_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
run = payload.get("data", payload) if isinstance(payload, dict) else payload
if not isinstance(run, dict) or not run.get("id"):
    raise SystemExit("Apify response did not contain a run ID")
print(run["id"], str(run.get("status") or "").upper(), run.get("defaultDatasetId") or "", sep="\t")
PY
}

IFS=$'\t' read -r run_id run_status dataset_id < <(parse_run "$start_response")
if [[ -z "${run_id:-}" ]]; then
  echo "Apify response did not contain a run ID" >&2
  exit 1
fi

deadline=$(( $(date +%s) + 480 ))
poll_count=0
while [[ "$run_status" == "READY" || "$run_status" == "RUNNING" ]]; do
  if (( poll_count >= 6 )); then
    echo "Actor run ${run_id} did not finish after ${poll_count} polls. Recovery run ID: ${run_id}" >&2
    exit 1
  fi
  if (( $(date +%s) >= deadline )); then
    echo "Actor run ${run_id} is still ${run_status} after the local deadline. Recovery run ID: ${run_id}" >&2
    exit 1
  fi

  sleep 5
  curl --silent --show-error --fail-with-body --max-time 70 \
    --header "Authorization: Bearer ${APIFY_TOKEN}" \
    --header "Accept: application/json" \
    "${api_base}/v2/actor-runs/${run_id}?waitForFinish=60" \
    --output "$poll_response"
  IFS=$'\t' read -r polled_run_id run_status dataset_id < <(parse_run "$poll_response")
  if [[ "$polled_run_id" != "$run_id" ]]; then
    echo "Apify poll response changed run ID from ${run_id} to ${polled_run_id}" >&2
    exit 1
  fi
  poll_count=$((poll_count + 1))
done

if [[ "$run_status" != "SUCCEEDED" ]]; then
  echo "Actor run ${run_id} ended with status ${run_status:-UNKNOWN}. Recovery run ID: ${run_id}" >&2
  exit 1
fi
if [[ -z "$dataset_id" ]]; then
  echo "Actor run ${run_id} succeeded without a defaultDatasetId" >&2
  exit 1
fi

curl --silent --show-error --fail-with-body --max-time 70 \
  --header "Authorization: Bearer ${APIFY_TOKEN}" \
  --header "Accept: application/json" \
  "${api_base}/v2/actor-runs/${run_id}/key-value-store/records/OUTPUT" \
  --output "$output_response"

# Enforce partial-run semantics before accepting the dataset.
summary_json="$(
  python3 - "$output_response" "$run_id" <<'PY'
import json
import sys

response_path, run_id = sys.argv[1:]
with open(response_path, encoding="utf-8") as handle:
    payload = json.load(handle)
summary = payload.get("data", payload) if isinstance(payload, dict) else payload
if not isinstance(summary, dict):
    raise SystemExit(f"Actor run {run_id}: OUTPUT summary must be an object")
fields = (
    "delivered",
    "uniqueJobs",
    "searchPages",
    "failedSearches",
    "failedJobDetails",
    "failedCompanies",
    "cacheHits",
)
clean = {"status": str(summary.get("status") or "")}
for field in fields:
    value = summary.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise SystemExit(f"Actor run {run_id}: OUTPUT summary has invalid {field}")
    clean[field] = value
stopped = summary.get("stoppedByBudget")
if not isinstance(stopped, bool):
    raise SystemExit(f"Actor run {run_id}: OUTPUT summary has invalid stoppedByBudget")
clean["stoppedByBudget"] = stopped
if clean["failedSearches"] > 0:
    raise SystemExit(
        f"Actor run {run_id} completed with {clean['failedSearches']} failed "
        f"search(es); no dataset was accepted. Recovery run ID: {run_id}"
    )
clean["coverage"] = (
    "partial"
    if (
        clean["failedJobDetails"] > 0
        or clean["failedCompanies"] > 0
        or clean["stoppedByBudget"]
    )
    else "complete"
)
print(json.dumps(clean, separators=(",", ":")))
PY
)"

curl --silent --show-error --fail-with-body --max-time 70 \
  --header "Authorization: Bearer ${APIFY_TOKEN}" \
  --header "Accept: application/json" \
  "${api_base}/v2/datasets/${dataset_id}/items?format=json&clean=true&limit=${limit}" \
  --output "$dataset_response"

python3 - "$dataset_response" "$output_path" "$run_id" "$summary_json" <<'PY'
import json
import sys
from urllib.parse import urlparse

response_path, output_path, run_id, summary_json = sys.argv[1:]
with open(response_path, encoding="utf-8") as handle:
    payload = json.load(handle)
if not isinstance(payload, list) and isinstance(payload, dict) and isinstance(payload.get("data"), list):
    payload = payload["data"]
if not isinstance(payload, list):
    raise SystemExit(f"Actor run {run_id}: dataset items response must be a JSON array")

for index, item in enumerate(payload):
    if not isinstance(item, dict):
        raise SystemExit(f"Actor run {run_id}: dataset item {index} is not an object")
    job_id = str(item.get("id") or "").strip()
    title = item.get("title") if isinstance(item.get("title"), str) else ""
    link = item.get("link") if isinstance(item.get("link"), str) else ""
    parsed = urlparse(link)
    host = (parsed.hostname or "").lower()
    if not job_id.isdigit() or not title.strip():
        raise SystemExit(
            f"Actor run {run_id}: dataset item {index} requires a numeric id and title"
        )
    if (
        parsed.scheme != "https"
        or not (host == "linkedin.com" or host.endswith(".linkedin.com"))
        or not parsed.path.startswith("/jobs/view/")
    ):
        raise SystemExit(
            f"Actor run {run_id}: dataset item {index} link must be a public LinkedIn job URL"
        )

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
print(
    f"Actor run {run_id} succeeded with {len(payload)} job(s); "
    f"wrote {output_path}"
)
summary = json.loads(summary_json)
print(f"Run summary: {json.dumps(summary, ensure_ascii=False)}")
if summary["coverage"] == "partial":
    print(
        "Warning: the Actor run was partial; inspect failedJobDetails, "
        "failedCompanies, and stoppedByBudget in the summary.",
        file=sys.stderr,
    )
PY
