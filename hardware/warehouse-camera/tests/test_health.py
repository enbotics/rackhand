import unittest

from app.health import DeviceHealthReporter


class FakeClient:
    def __init__(self, error=None):
        self.error = error
        self.payloads = []

    def report_device_health(self, payload):
        if self.error:
            raise self.error
        self.payloads.append(payload)


class DeviceHealthReporterTest(unittest.TestCase):
    def test_reports_current_capture_state(self):
        client = FakeClient()
        reporter = DeviceHealthReporter(client, 15)
        reporter.update(
            "CAPTURING",
            camera_ready=True,
            preview_ready=True,
            active_job_id="job-123",
        )

        reporter.send_now()

        self.assertEqual(len(client.payloads), 1)
        self.assertEqual(client.payloads[0]["workerState"], "CAPTURING")
        self.assertEqual(client.payloads[0]["activeJobId"], "job-123")
        self.assertTrue(client.payloads[0]["cameraReady"])

    def test_reporting_failure_does_not_escape(self):
        reporter = DeviceHealthReporter(FakeClient(RuntimeError("offline")), 15)
        reporter.send_now()

    def test_rejects_non_positive_interval(self):
        with self.assertRaises(ValueError):
            DeviceHealthReporter(FakeClient(), 0)


if __name__ == "__main__":
    unittest.main()
