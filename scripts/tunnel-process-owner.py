#!/usr/bin/env python3
"""Local cooperative ownership, not a security boundary against the same OS user.

No process-name adoption or mass signalling. A receipt binds PID, UID, start time,
exact argv and this state's pidfile marker. Keep the daemon lock inode permanent.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


def ps(*args):
    result = subprocess.run(["ps", "-ww", *args], capture_output=True, text=True,
                            env={**os.environ, "LC_ALL": "C"}, timeout=5)
    if result.returncode != 0 and not (result.returncode == 1 and "-p" in args and not result.stdout.strip()):
        raise ValueError("process discovery unavailable")
    return result.stdout.strip()


def identity(pid):
    text = ps("-p", str(pid), "-o", "uid=,lstart=,stat=,command=")
    fields = text.split(None, 7)
    if not fields or (len(fields) == 8 and fields[6].startswith("Z")):
        return None
    if len(fields) != 8:
        raise ValueError("process identity unavailable")
    return {"pid": pid, "uid": int(fields[0]), "start": " ".join(fields[1:6]),
            "command": fields[7]}


def main():
    state = Path(sys.argv[1]).absolute()
    port, action = sys.argv[2:4]
    if not re.fullmatch(r"[0-9]{1,5}", port) or not 1 <= int(port) <= 65535:
        raise ValueError("invalid origin")
    info = state.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("state directory must be private and owned")
    receipt = state / "tunnel-owner.json"
    origin = "http://localhost:" + port
    binary = shutil.which("cloudflared")
    if not binary:
        raise ValueError("cloudflared unavailable")
    expected = " ".join([binary, "tunnel", "--no-autoupdate", "--protocol", "http2",
                         "--pidfile", str(state / "cloudflared.pid"), "--url", origin])

    def read_owner():
        if not receipt.exists() and not receipt.is_symlink():
            return None
        meta = receipt.lstat()
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid() or meta.st_mode & 0o077:
            raise ValueError("unsafe ownership receipt")
        data = json.loads(receipt.read_text())
        if (not isinstance(data, dict) or type(data.get("pid")) is not int or data["pid"] <= 1
                or data.get("uid") != os.getuid() or data.get("command") != expected
                or not isinstance(data.get("start"), str)):
            raise ValueError("invalid ownership receipt")
        return data

    def current_owner():
        owner = read_owner()
        if owner is None:
            return None
        actual = identity(owner["pid"])
        if actual is not None and actual != owner:
            # A stale PID is not ownership. Discovery still rejects an unrecorded
            # same-origin tunnel, but an unrelated reused PID need not block startup.
            return None
        return actual

    def preflight():
        owner = current_owner()
        # Discovery is read-only. Unknown same-origin tunnels block migration;
        # tunnels for other ports/projects are neither adopted nor stopped.
        for line in ps("-axo", "pid=,uid=,command=").splitlines():
            fields = line.strip().split(None, 2)
            if len(fields) != 3:
                continue
            pid, uid, command = fields
            if int(uid) != os.getuid():
                continue
            if (re.match(r"(?:.+/)?cloudflared\s+tunnel\s", command)
                    and re.search(r"--url(?:=|\s+)" + re.escape(origin) + r"(?:\s|$)", command)
                    and (owner is None or int(pid) != owner["pid"])):
                raise ValueError("unrecorded same-origin tunnel; manual migration required")
        return owner

    if action == "lock":
        lock = state / "tunnel-daemon.lock"
        descriptor = os.fstat(8)
        meta = lock.lstat()
        if (not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid()
                or meta.st_mode & 0o077 or (meta.st_dev, meta.st_ino) != (descriptor.st_dev, descriptor.st_ino)):
            raise ValueError("unsafe daemon lock")
        try:
            fcntl.flock(8, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 75
    elif action == "preflight":
        preflight()
    elif action == "status":
        owner = current_owner()
        if owner:
            print(owner["pid"])
    elif action == "record":
        pid = int(sys.argv[4])
        actual = identity(pid)
        if pid <= 1 or actual is None or actual["uid"] != os.getuid() or actual["command"] != expected:
            raise ValueError("new process does not match this tunnel")
        # Only the launcher may register its direct child. Existing receipts are
        # adopted via status, never by accepting an arbitrary supplied PID.
        if int(ps("-p", str(pid), "-o", "ppid=")) != os.getppid():
            raise ValueError("not a child of this launcher")
        old = current_owner()
        if old is not None and old != actual:
            raise ValueError("another owned tunnel is still running")
        fd, temporary = tempfile.mkstemp(prefix=".tunnel-owner-", dir=state)
        try:
            with os.fdopen(fd, "w") as output:
                json.dump(actual, output)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, receipt)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    elif action == "stop":
        owner = preflight()
        if owner:
            # Revalidate immediately before signalling. Portable ps+kill is not
            # an atomic kernel handle; same-user hostile replacement is out of scope.
            if identity(owner["pid"]) != owner:
                raise ValueError("identity changed before stop")
            try:
                os.kill(owner["pid"], signal.SIGTERM)
            except ProcessLookupError:
                return 0
            for _ in range(50):
                if identity(owner["pid"]) != owner:
                    return 0
                time.sleep(0.1)
            raise ValueError("owned tunnel did not exit; no forced kill or replacement")
    else:
        raise ValueError("unknown operation")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        # Never print discovered argv, receipt contents or exception payloads.
        print("隧道进程归属无法确认或未停止；未接管/强杀未知进程。请核对本项目进程记录及旧版隧道。", file=sys.stderr)
        sys.exit(1)
