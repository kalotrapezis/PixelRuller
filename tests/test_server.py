import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock

import server


PNG = b"\x89PNG\r\n\x1a\nTEST"


class ScreenshotBackendTests(unittest.TestCase):
    @mock.patch.dict(os.environ, {"PIXELRULLER_SCREENSHOT_COMMAND": ""})
    @mock.patch("server.shutil.which")
    @mock.patch("server.subprocess.run")
    def test_capture_falls_back_to_next_available_tool(self, run, which):
        which.side_effect = lambda name: f"/fake/{name}" if name in {"spectacle", "gnome-screenshot"} else None

        def execute(command, **_kwargs):
            if command[0] == "spectacle":
                return subprocess.CompletedProcess(command, 1, "", "KDE session unavailable")
            Path(command[-1]).write_bytes(PNG)
            return subprocess.CompletedProcess(command, 0, "", "")

        run.side_effect = execute
        image, backend = server.capture_screenshot()

        self.assertEqual(image, PNG)
        self.assertEqual(backend, "GNOME Screenshot")
        self.assertEqual([call.args[0][0] for call in run.call_args_list], ["spectacle", "gnome-screenshot"])

    @mock.patch.dict(
        os.environ,
        {"PIXELRULLER_SCREENSHOT_COMMAND": "custom-shot --file \"{output}\""},
    )
    @mock.patch("server.shutil.which", return_value=None)
    def test_custom_command_template_supports_any_tool(self, _which):
        commands = list(server.screenshot_commands("/tmp/pixel ruler.png"))
        self.assertEqual(
            commands,
            [("Custom command", ["custom-shot", "--file", "/tmp/pixel ruler.png"])],
        )

    @mock.patch.dict(os.environ, {"PIXELRULLER_SCREENSHOT_COMMAND": ""})
    @mock.patch("server.shutil.which", return_value=None)
    def test_clear_error_when_no_tool_exists(self, _which):
        with self.assertRaisesRegex(RuntimeError, "No compatible screenshot tool found"):
            server.capture_screenshot()


class CommandBrokerTests(unittest.TestCase):
    def test_command_round_trip(self):
        broker = server.CommandBroker()
        item_id = broker.enqueue('select "Apply changes"')

        self.assertEqual(
            broker.take_next(),
            {"id": item_id, "command": 'select "Apply changes"'},
        )
        self.assertEqual(broker.result(item_id)["status"], "running")
        self.assertTrue(broker.complete(item_id, {"ok": True, "msg": "selected"}))
        self.assertEqual(
            broker.result(item_id),
            {"id": item_id, "status": "complete", "result": {"ok": True, "msg": "selected"}},
        )

    def test_rejects_empty_and_oversized_commands(self):
        broker = server.CommandBroker()
        with self.assertRaisesRegex(ValueError, "required"):
            broker.enqueue("  ")
        with self.assertRaisesRegex(ValueError, "too long"):
            broker.enqueue("x" * 4097)


if __name__ == "__main__":
    unittest.main()
