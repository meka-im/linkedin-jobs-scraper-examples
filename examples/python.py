#!/usr/bin/env python3

import argparse
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


ACTOR_ID = "meka.im~linkedin-jobs-scraper"
DEFAULT_API_BASE_URL = "https://api.apify.com"
PENDING_STATUSES = {"READY", "RUNNING"}


class ActorRunError(RuntimeError):
    def __init__(self, message: str, run_id: str | None = None, status: str | None = None):
        super().__init__(message)
        self.run_id = run_id
        self.status = status


def request_json(
    url: str,
    token: str,
    *,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    run_id: str | None = None,
) -> Any:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")

    request = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=70) as response:
            body = response.read().decode("utf-8")
    except HTTPError as error:
        suffix = f" for run {run_id}" if run_id else ""
        raise ActorRunError(
            f"Apify request returned HTTP {error.code}{suffix}",
            run_id=run_id,
        ) from None
    except (URLError, TimeoutError) as error:
        suffix = f" for run {run_id}" if run_id else ""
        raise ActorRunError(
            f"Apify request failed{suffix}: {error.reason if isinstance(error, URLError) else error}",
            run_id=run_id,
        ) from None

    if not body.strip():
        raise ActorRunError("Apify returned an empty response body", run_id=run_id)
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise ActorRunError("Apify returned invalid JSON", run_id=run_id) from None


def as_run(payload: Any) -> dict[str, Any]:
    run = payload.get("data", payload) if isinstance(payload, dict) else payload
    if not isinstance(run, dict):
        raise ActorRunError("Apify response did not contain a run object")
    return run


def run_id_of(run: dict[str, Any]) -> str:
    run_id = str(run.get("id") or "").strip()
    if not run_id:
        raise ActorRunError("Apify response did not contain a run ID")
    return run_id


def status_of(run: dict[str, Any]) -> str:
    return str(run.get("status") or "").strip().upper()


def dataset_id_of(run: dict[str, Any]) -> str:
    return str(run.get("defaultDatasetId") or "").strip()


def validate_actor_input(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise ActorRunError("Input must be a JSON object")
    count = payload.get("count")
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise ActorRunError("input.count must be a positive integer")
    limit = payload.get("limitPerSource")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ActorRunError("input.limitPerSource must be a positive integer")
    keywords = payload.get("keywords")
    urls = payload.get("urls")
    companies = payload.get("companyIds")
    if (
        not (isinstance(keywords, str) and keywords.strip())
        and not (isinstance(urls, list) and urls)
        and not (isinstance(companies, list) and companies)
    ):
        raise ActorRunError("Input must include keywords, urls, or companyIds")
    if payload.get("datePosted") is not None and payload["datePosted"] not in {
        "anyTime",
        "past24Hours",
        "pastWeek",
        "pastMonth",
    }:
        raise ActorRunError("input.datePosted has an unsupported value")
    if payload.get("scrapeCompany") is not None and not isinstance(
        payload["scrapeCompany"], bool
    ):
        raise ActorRunError("input.scrapeCompany must be a boolean")


def validate_jobs(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        raise ActorRunError("Dataset items response must be a JSON array")
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise ActorRunError(f"Dataset item {index} is not an object")
        job_id = str(item.get("id") or "").strip()
        title = item.get("title") if isinstance(item.get("title"), str) else ""
        link = item.get("link") if isinstance(item.get("link"), str) else ""
        if not job_id.isdigit() or not title.strip():
            raise ActorRunError(
                f"Dataset item {index} must include a numeric id and non-empty title"
            )
        parsed = urlparse(link)
        host = (parsed.hostname or "").lower()
        if (
            parsed.scheme != "https"
            or not (host == "linkedin.com" or host.endswith(".linkedin.com"))
            or not parsed.path.startswith("/jobs/view/")
        ):
            raise ActorRunError(
                f"Dataset item {index} link must be a public LinkedIn job URL"
            )
    return items


def run_linkedin_jobs(
    payload: dict[str, Any],
    token: str,
    *,
    api_base_url: str = DEFAULT_API_BASE_URL,
    sleep_fn: Callable[[float], None] = time.sleep,
    now_fn: Callable[[], float] = time.monotonic,
    poll_delay_seconds: float = 5,
    max_poll_attempts: int = 6,
    run_deadline_seconds: float = 480,
) -> dict[str, Any]:
    if not token.strip():
        raise ActorRunError("APIFY_TOKEN is required")
    validate_actor_input(payload)

    base = api_base_url.rstrip("/")
    start_query = urlencode(
        {
            "memory": 512,
            "timeout": 300,
            "maxTotalChargeUsd": "0.05",
            "waitForFinish": 60,
        }
    )
    start_url = f"{base}/v2/acts/{ACTOR_ID}/runs?{start_query}"

    # Send POST exactly once; retrying it could start and charge for another run.
    run = as_run(request_json(start_url, token, method="POST", payload=payload))
    run_id = run_id_of(run)
    deadline = now_fn() + run_deadline_seconds
    poll_count = 0

    while status_of(run) in PENDING_STATUSES:
        if poll_count >= max_poll_attempts:
            raise ActorRunError(
                f"Actor run {run_id} did not finish after {poll_count} polls. "
                f"Recovery run ID: {run_id}",
                run_id=run_id,
                status=status_of(run),
            )
        if now_fn() >= deadline:
            raise ActorRunError(
                f"Actor run {run_id} is still {status_of(run)} after the local deadline. "
                f"Recovery run ID: {run_id}",
                run_id=run_id,
                status=status_of(run),
            )

        sleep_fn(poll_delay_seconds)
        poll_url = (
            f"{base}/v2/actor-runs/{run_id}?"
            + urlencode({"waitForFinish": 60})
        )
        run = as_run(request_json(poll_url, token, run_id=run_id))
        polled_run_id = run_id_of(run)
        if polled_run_id != run_id:
            raise ActorRunError(
                f"Apify poll response changed run ID from {run_id} to {polled_run_id}",
                run_id=run_id,
            )
        poll_count += 1

    status = status_of(run)
    if status != "SUCCEEDED":
        raise ActorRunError(
            f"Actor run {run_id} ended with status {status or 'UNKNOWN'}. "
            f"Recovery run ID: {run_id}",
            run_id=run_id,
            status=status,
        )

    dataset_id = dataset_id_of(run)
    if not dataset_id:
        raise ActorRunError(
            f"Actor run {run_id} succeeded without a defaultDatasetId",
            run_id=run_id,
            status=status,
        )

    output_url = (
        f"{base}/v2/actor-runs/{run_id}/key-value-store/records/OUTPUT"
    )
    output_payload = request_json(output_url, token, run_id=run_id)
    summary_payload = (
        output_payload.get("data", output_payload)
        if isinstance(output_payload, dict)
        else output_payload
    )
    if not isinstance(summary_payload, dict):
        raise ActorRunError(
            f"Actor run {run_id} returned an invalid OUTPUT summary",
            run_id=run_id,
            status=status,
        )

    numeric_fields = [
        "delivered",
        "uniqueJobs",
        "searchPages",
        "failedSearches",
        "failedJobDetails",
        "failedCompanies",
        "cacheHits",
    ]
    summary: dict[str, Any] = {"status": str(summary_payload.get("status") or "")}
    for field in numeric_fields:
        value = summary_payload.get(field)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ActorRunError(
                f"Actor run {run_id} OUTPUT summary has an invalid {field}",
                run_id=run_id,
                status=status,
            )
        summary[field] = value
    stopped_by_budget = summary_payload.get("stoppedByBudget")
    if not isinstance(stopped_by_budget, bool):
        raise ActorRunError(
            f"Actor run {run_id} OUTPUT summary has an invalid stoppedByBudget",
            run_id=run_id,
            status=status,
        )
    summary["stoppedByBudget"] = stopped_by_budget
    if summary["failedSearches"] > 0:
        raise ActorRunError(
            f"Actor run {run_id} completed with "
            f"{summary['failedSearches']} failed search(es); no dataset was accepted. "
            f"Recovery run ID: {run_id}",
            run_id=run_id,
            status=status,
        )
    summary["coverage"] = (
        "partial"
        if (
            summary["failedJobDetails"] > 0
            or summary["failedCompanies"] > 0
            or summary["stoppedByBudget"]
        )
        else "complete"
    )

    limit = payload["count"]
    dataset_query = urlencode({"format": "json", "clean": "true", "limit": limit})
    dataset_url = f"{base}/v2/datasets/{dataset_id}/items?{dataset_query}"
    items_payload = request_json(dataset_url, token, run_id=run_id)
    if isinstance(items_payload, dict) and isinstance(items_payload.get("data"), list):
        items_payload = items_payload["data"]
    jobs = validate_jobs(items_payload)

    return {
        "runId": run_id,
        "datasetId": dataset_id,
        "status": status,
        "requestedLimit": limit,
        "summary": summary,
        "jobs": jobs,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the MEKA LinkedIn Jobs Actor")
    parser.add_argument(
        "input",
        nargs="?",
        default=Path(__file__).with_name("input.json"),
        type=Path,
        help="Actor input JSON (default: examples/input.json)",
    )
    parser.add_argument(
        "output",
        nargs="?",
        default=Path.cwd() / "jobs.json",
        type=Path,
        help="Dataset items output JSON (default: ./jobs.json)",
    )
    args = parser.parse_args()

    token = os.environ.get("APIFY_TOKEN", "")
    try:
        if not token:
            raise ActorRunError("Set APIFY_TOKEN in your environment")
        payload = json.loads(args.input.read_text(encoding="utf-8"))
        result = run_linkedin_jobs(payload, token)
        args.output.write_text(
            json.dumps(result["jobs"], indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(
            f"Actor run {result['runId']} succeeded with "
            f"{len(result['jobs'])} job(s); wrote {args.output}"
        )
        print(f"Run summary: {json.dumps(result['summary'], ensure_ascii=False)}")
        if result["summary"]["coverage"] == "partial":
            print(
                "Warning: the Actor run was partial; inspect failedJobDetails, "
                "failedCompanies, and stoppedByBudget in the summary.",
                file=sys.stderr,
            )
        return 0
    except (ActorRunError, OSError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
