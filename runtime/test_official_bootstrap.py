"""Safety checks for discovery and shutdown; no real processes are changed."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / "Sources/RemoteCodex/Resources/official_runtime.py"
spec = importlib.util.spec_from_file_location("official_bootstrap", source)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = bootstrap.Runtime("/fixture/codex", home=self.temp.name)
        self.info = {"pid": 1234, "startTicks": "456", "socket": str(self.runtime.canonical)}

    def testCanonicalIsPreferredWithoutStartingAnotherProcess(self):
        self.runtime.legacy = Path(self.temp.name) / "legacy.sock"
        with patch.object(self.runtime, "probe", return_value=self.info) as probe, patch.object(bootstrap.subprocess, "Popen") as spawn:
            self.assertEqual(self.runtime.ensure(), self.info)
            probe.assert_called_once_with(self.runtime.canonical)
            spawn.assert_not_called()

    def testLegacyInstanceIsReusedWhenCanonicalIsAbsent(self):
        self.runtime.legacy = Path(self.temp.name) / "legacy.sock"
        with patch.object(self.runtime, "probe", side_effect=[bootstrap.MissingRuntime(), self.info]) as probe, patch.object(bootstrap.subprocess, "Popen") as spawn:
            self.assertEqual(self.runtime.ensure(), self.info)
            self.assertEqual(probe.call_args_list[1].args, (self.runtime.legacy,))
            spawn.assert_not_called()

    def testUnresponsiveExistingServiceDoesNotCreateAnother(self):
        with patch.object(self.runtime, "probe", side_effect=TimeoutError("unresponsive")), patch.object(bootstrap.subprocess, "Popen") as spawn:
            with self.assertRaises(TimeoutError): self.runtime.ensure()
            spawn.assert_not_called()

    def testIsolatedHomeCannotProbeProductionLegacySocket(self):
        self.assertIsNone(self.runtime.legacy)

    def testManualShutdownPreventsAutomaticCreation(self):
        self.runtime.control.mkdir()
        self.runtime.save_owner({"disabled": True})
        with patch.object(self.runtime, "existing", return_value=None), patch.object(bootstrap.subprocess, "Popen") as spawn:
            with self.assertRaisesRegex(RuntimeError, "手动关闭"): self.runtime.ensure()
            spawn.assert_not_called()

    def testPidReuseOrDifferentSocketCannotGrantShutdownOwnership(self):
        self.runtime.control.mkdir()
        self.runtime.save_owner({**self.info, "startTicks": "old-start"})
        self.assertFalse(self.runtime.owned(self.info))
        self.runtime.save_owner({**self.info, "socket": "/some/other/socket"})
        self.assertFalse(self.runtime.owned(self.info))

    def testExternalOrBusyServiceIsNeverStopped(self):
        for owned, loaded, active, clients in [(False, 0, 0, 0), (True, 1, 0, 0), (True, 0, 1, 0), (True, 0, 0, 1)]:
            state = {**self.info, "owned": owned, "loadedThreads": loaded, "activeTurns": active, "clients": clients, "running": True}
            with self.subTest(state=state), patch.object(self.runtime, "existing", return_value=self.info), patch.object(self.runtime, "inspect", return_value=state), patch.object(bootstrap.os, "kill") as kill:
                self.assertTrue(self.runtime.stop_idle_owned()["detached"])
                kill.assert_not_called()


if __name__ == "__main__": unittest.main()
