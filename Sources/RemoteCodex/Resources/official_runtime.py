"""Short-lived discovery/launcher. Only the official Codex binary stays running."""
import argparse
import base64
import errno
import fcntl
import hashlib
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path


class MissingRuntime(Exception):
    pass


class RPC:
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(5)
        try:
            # Official Codex redirects long control paths to a short socket via symlink.
            self.sock.connect(str(Path(path).resolve(strict=True)))
            key = base64.b64encode(os.urandom(16)).decode()
            self.sock.sendall(("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + "\r\n\r\n").encode())
            header = bytearray()
            while not header.endswith(b"\r\n\r\n"):
                header.extend(self.exact(1))
                if len(header) > 16384:
                    raise RuntimeError("Invalid official service handshake")
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
            if not header.startswith(b"HTTP/1.1 101 ") or accept.lower() not in header.lower():
                raise RuntimeError("Invalid official service handshake")
            self.sequence = 0
            self.hello = self.request("initialize", {"clientInfo": {"name": "remote_codex_runtime_discovery", "version": "0.4.0"}, "capabilities": {"experimentalApi": True}})
            self.send({"method": "initialized", "params": {}})
        except BaseException:
            self.sock.close()
            raise

    def exact(self, count):
        value = bytearray()
        while len(value) < count:
            part = self.sock.recv(count - len(value))
            if not part:
                raise ConnectionError("Official service disconnected")
            value.extend(part)
        return bytes(value)

    def frame(self, data, opcode=1):
        size = len(data)
        prefix = bytes([128 | opcode, 128 | size]) if size < 126 else bytes([128 | opcode, 254]) + struct.pack("!H", size) if size < 65536 else bytes([128 | opcode, 255]) + struct.pack("!Q", size)
        mask = os.urandom(4)
        self.sock.sendall(prefix + mask + bytes(v ^ mask[i % 4] for i, v in enumerate(data)))

    def send(self, value):
        self.frame(json.dumps(value).encode())

    def request(self, method, params=None):
        self.sequence += 1
        identifier = "discovery-" + str(self.sequence)
        self.send({"id": identifier, "method": method, "params": params or {}})
        fragments = bytearray()
        while True:
            h = self.exact(2)
            opcode, size = h[0] & 15, h[1] & 127
            if h[1] & 128 or h[0] & 112:
                raise RuntimeError("Invalid official service frame")
            if size == 126:
                size = struct.unpack("!H", self.exact(2))[0]
            elif size == 127:
                size = struct.unpack("!Q", self.exact(8))[0]
            if size > 32000000 or len(fragments) + size > 32000000:
                raise RuntimeError("Oversize official service response")
            data = self.exact(size)
            if opcode == 8:
                raise ConnectionError("Official service closed")
            if opcode == 9:
                self.frame(data, 10)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise RuntimeError("Invalid official service frame")
            fragments.extend(data)
            if not h[0] & 128:
                continue
            value = json.loads(fragments)
            fragments.clear()
            if value.get("id") == identifier and "method" not in value:
                if "error" in value:
                    raise RuntimeError("Official service rejected " + method)
                return value.get("result", {})
            # Discovery never subscribes, answers questions, or approves tools.

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.sock.close()


def process_stamp(pid):
    try:
        raw = Path("/proc", str(pid), "stat").read_text()
        fields = raw[raw.rindex(")") + 2:].split()
        return fields[19] if fields[0] != "Z" else None
    except (OSError, ValueError, IndexError):
        return None


class Runtime:
    def __init__(self, executable, home=None, explicit_socket=None, legacy_socket=None):
        self.executable = str(Path(executable).expanduser())
        self.home = Path(home or os.environ.get("CODEX_HOME") or Path.home() / ".codex").resolve()
        self.control = self.home / "app-server-control"
        self.canonical = Path(explicit_socket) if explicit_socket else self.control / "app-server-control.sock"
        self.explicit = explicit_socket is not None
        self.legacy = Path(legacy_socket) if legacy_socket else (Path.home() / ".local/state/remote-codex-runtime/official.sock" if self.home == (Path.home() / ".codex").resolve() and not self.explicit else None)
        self.marker = self.control / "remote-codex-owner.json"

    def ownership(self):
        try:
            return json.loads(self.marker.read_text())
        except (OSError, ValueError):
            return {}

    def owned(self, info):
        record = self.ownership()
        return not self.explicit and record.get("pid") == info["pid"] and record.get("startTicks") == info.get("startTicks") and record.get("socket") == info["socket"] and info.get("startTicks") is not None

    def probe(self, path):
        try:
            with RPC(path) as rpc:
                if not self.explicit and Path(rpc.hello.get("codexHome", "")).resolve() != self.home:
                    raise RuntimeError("Official service uses a different CODEX_HOME")
                diagnostic = rpc.request("server/diagnostics")
                pid = diagnostic.get("process", {}).get("id")
                if not isinstance(pid, int) or Path(os.readlink("/proc/" + str(pid) + "/exe")).name != "codex":
                    raise RuntimeError("Could not verify official Codex service")
                return {"pid": pid, "startTicks": process_stamp(pid), "socket": str(path)}
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ECONNREFUSED):
                raise MissingRuntime() from error
            raise RuntimeError("Official service is present but not responding; no additional instance was created") from error

    def existing(self):
        for path in [self.canonical] + ([self.legacy] if self.legacy and self.legacy != self.canonical else []):
            try:
                return self.probe(path)
            except MissingRuntime:
                pass
        return None

    def lock(self):
        self.control.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.control / "remote-codex-bootstrap.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        file = os.fdopen(fd, "a")
        fcntl.flock(file, fcntl.LOCK_EX)
        return file

    def save_owner(self, value):
        temporary = self.marker.with_name(self.marker.name + "." + str(os.getpid()) + ".new")
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as out:
            json.dump(value, out)
        os.replace(temporary, self.marker)

    def ensure(self, explicit_start=False):
        info = self.existing()
        if info:
            return info
        if self.explicit:
            raise RuntimeError("The explicitly configured official service is not running")
        with self.lock():
            info = self.existing()
            if info:
                return info
            if self.ownership().get("disabled") and not explicit_start:
                raise RuntimeError("远端常驻已手动关闭，请在连接设置中重新开启。")
            log_fd = os.open(self.control / "remote-codex-start.log", os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(log_fd, "ab") as log:
                env = dict(os.environ, CODEX_HOME=str(self.home))
                child = subprocess.Popen([self.executable, "app-server", "--listen", "unix://"], cwd=Path.home(), env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    info = self.probe(self.canonical)
                except MissingRuntime:
                    info = None
                if info:
                    if info["pid"] == child.pid:
                        self.save_owner({**info, "home": str(self.home), "disabled": False, "createdAt": time.time()})
                    elif child.poll() is None:
                        # Another official starter won the socket race; stop only our unused candidate.
                        child.terminate()
                        child.wait(timeout=5)
                    return info
                if child.poll() is not None:
                    raise RuntimeError("Official Codex failed to start; see " + str(self.control / "remote-codex-start.log"))
                time.sleep(0.1)
            raise RuntimeError("Official Codex startup timed out; existing services were not restarted")

    @staticmethod
    def clients(path):
        actual = str(Path(path).resolve())
        return sum(1 for line in Path("/proc/net/unix").read_text().splitlines()[1:]
                   if len(parts := line.split(maxsplit=7)) == 8 and parts[7] == actual and parts[5] == "03")

    def inspect(self, info):
        with RPC(info["socket"]) as rpc:
            diagnostics = rpc.request("server/diagnostics")
            if diagnostics.get("process", {}).get("id") != info["pid"]:
                raise RuntimeError("Official service changed; please retry")
            loaded = rpc.request("thread/loaded/list").get("data", [])
            gauges = {g["name"]: g["value"] for g in diagnostics.get("gauges", [])}
            clients = max(0, self.clients(info["socket"]) - 1)  # Exclude this administrative connection.
            owned = self.owned(info)
            active = int(gauges.get("core.turns.active", 0))
            return {**info, "running": True, "official": True, "persistent": True, "owned": owned, "shared": not owned,
                    "clients": clients, "loadedThreads": len(loaded), "activeTurns": active,
                    "canStop": owned and not loaded and not active and clients <= 1}

    def status(self):
        info = self.existing()
        return self.inspect(info) if info else {"running": False, "official": True, "owned": False, "canStop": False, "disabled": bool(self.ownership().get("disabled"))}

    def stop_idle_owned(self):
        with self.lock():
            info = self.existing()
            if not info:
                return {"running": False}
            state = self.inspect(info)
            if not state["owned"] or state["loadedThreads"] or state["activeTurns"] or state["clients"]:
                return {**state, "detached": True}
            if process_stamp(info["pid"]) != info["startTicks"]:
                raise RuntimeError("Official service changed; shutdown was cancelled")
            os.kill(info["pid"], signal.SIGTERM)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and process_stamp(info["pid"]) == info["startTicks"]:
                time.sleep(0.1)
            if process_stamp(info["pid"]) == info["startTicks"]:
                raise RuntimeError("Official service is still shutting down; it was not force-killed")
            self.save_owner({**self.ownership(), "disabled": True})
            return {"running": False, "stoppedOwnedIdleRuntime": True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["proxy", "status", "start", "stop"])
    parser.add_argument("--executable", required=True)
    parser.add_argument("--project")
    parser.add_argument("--socket")
    parser.add_argument("--home")
    args = parser.parse_args()
    if not Path(args.executable).is_absolute() or not Path(args.executable).is_file():
        raise RuntimeError("Codex executable must be an existing absolute path")
    runtime = Runtime(args.executable, home=args.home, explicit_socket=args.socket)
    if args.operation == "proxy":
        if not args.project or not Path(args.project).is_absolute() or not Path(args.project).is_dir():
            raise RuntimeError("Remote project must be an existing absolute directory")
        info = runtime.ensure()
        os.chdir(args.project)
        os.execv(args.executable, [args.executable, "app-server", "proxy", "--sock", info["socket"]])
    elif args.operation == "start":
        print(json.dumps(runtime.inspect(runtime.ensure(explicit_start=True))))
    elif args.operation == "stop":
        print(json.dumps(runtime.stop_idle_owned()))
    else:
        print(json.dumps(runtime.status()))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
