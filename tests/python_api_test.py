import importlib.util
import json
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest


ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = ROOT / "examples" / "python.py"
SPEC = importlib.util.spec_from_file_location("linkedin_python_example", MODULE_PATH)
EXAMPLE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(EXAMPLE)


class MockHandler(BaseHTTPRequestHandler):
    requests = []
    dataset = []
    run_status = "SUCCEEDED"
    failed_searches = 0

    def log_message(self, _format, *_args):
        pass

    def _record(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length).decode("utf-8")
        type(self).requests.append(
            {
                "method": self.command,
                "path": self.path,
                "authorization": self.headers.get("authorization"),
                "body": body,
            }
        )

    def _reply(self, status, payload):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_POST(self):
        self._record()
        self._reply(
            201,
            {
                "data": {
                    "id": "python-run",
                    "status": self.run_status,
                    "defaultDatasetId": "python-dataset",
                }
            },
        )

    def do_GET(self):
        self._record()
        if self.path.endswith("/records/OUTPUT"):
            self._reply(
                200,
                {
                    "status": "completed",
                    "delivered": len(self.dataset),
                    "uniqueJobs": len(self.dataset),
                    "searchPages": 1,
                    "failedSearches": self.failed_searches,
                    "failedJobDetails": 0,
                    "failedCompanies": 0,
                    "stoppedByBudget": False,
                    "cacheHits": 0,
                },
            )
            return
        self._reply(200, self.dataset)


class PythonApiExampleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        MockHandler.requests = []
        MockHandler.dataset = []
        MockHandler.run_status = "SUCCEEDED"
        MockHandler.failed_searches = 0

    def test_empty_success_posts_once_and_uses_authorization_header(self):
        result = EXAMPLE.run_linkedin_jobs(
            {
                "keywords": "software engineer",
                "location": "London, United Kingdom",
                "datePosted": "pastWeek",
                "count": 10,
                "limitPerSource": 10,
                "scrapeCompany": False,
            },
            "python-test-token",
            api_base_url=self.base_url,
            sleep_fn=lambda _seconds: None,
        )

        self.assertEqual(result["runId"], "python-run")
        self.assertEqual(result["jobs"], [])
        self.assertEqual(result["summary"]["coverage"], "complete")
        self.assertEqual(
            [request["method"] for request in MockHandler.requests],
            ["POST", "GET", "GET"],
        )
        self.assertEqual(
            MockHandler.requests[0]["path"],
            "/v2/acts/meka.im~linkedin-jobs-scraper/runs"
            "?memory=512&timeout=300&maxTotalChargeUsd=0.05&waitForFinish=60",
        )
        self.assertEqual(
            MockHandler.requests[0]["authorization"],
            "Bearer python-test-token",
        )
        self.assertTrue(
            all(
                "python-test-token" not in request["path"]
                for request in MockHandler.requests
            )
        )
        self.assertEqual(
            MockHandler.requests[2]["path"],
            "/v2/datasets/python-dataset/items?format=json&clean=true&limit=10",
        )

    def test_invalid_count_stops_before_post(self):
        with self.assertRaisesRegex(
            EXAMPLE.ActorRunError, r"input\.count must be a positive integer"
        ):
            EXAMPLE.run_linkedin_jobs(
                {
                    "keywords": "software engineer",
                    "count": 0,
                    "limitPerSource": 10,
                },
                "python-test-token",
                api_base_url=self.base_url,
                sleep_fn=lambda _seconds: None,
            )
        self.assertEqual(MockHandler.requests, [])

    def test_failed_run_does_not_fetch_dataset(self):
        MockHandler.run_status = "FAILED"
        with self.assertRaisesRegex(EXAMPLE.ActorRunError, r"python-run.*FAILED"):
            EXAMPLE.run_linkedin_jobs(
                {
                    "keywords": "software engineer",
                    "count": 10,
                    "limitPerSource": 10,
                },
                "python-test-token",
                api_base_url=self.base_url,
                sleep_fn=lambda _seconds: None,
            )
        self.assertEqual(
            [request["method"] for request in MockHandler.requests],
            ["POST"],
        )

    def test_failed_search_rejects_dataset_and_reports_partial_failure(self):
        MockHandler.failed_searches = 1
        with self.assertRaisesRegex(
            EXAMPLE.ActorRunError, r"python-run.*failed search"
        ):
            EXAMPLE.run_linkedin_jobs(
                {
                    "keywords": "software engineer",
                    "count": 10,
                    "limitPerSource": 10,
                },
                "python-test-token",
                api_base_url=self.base_url,
                sleep_fn=lambda _seconds: None,
            )
        self.assertEqual(
            [request["method"] for request in MockHandler.requests],
            ["POST", "GET"],
        )


if __name__ == "__main__":
    unittest.main()
