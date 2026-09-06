"""Exercise Android's exact JNI primitive ABI against the desktop executable.

Runs on Linux in CI; Android instrumentation covers JVM linkage separately.
"""
import ctypes
import json
from pathlib import Path
import queue
import socket
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "transport-core/target/release"


class Peer:
    def __init__(self, native):
        self.events = queue.Queue()
        self.process = None
        self.thread = None
        if native:
            library = ctypes.CDLL(str(RELEASE / "libp2pshare_transport.so"))
            run = library.Java_com_p2pshare_android_QuicTransport_nativeRun
            run.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]
            run.restype = ctypes.c_int
            self.socket, engine = socket.socketpair()
            fd = engine.detach()
            self.result = None
            def target():
                self.result = run(None, None, fd)
            self.thread = threading.Thread(target=target)
            self.thread.start()
            self.reader = self.socket.makefile("rb")
            self.writer = self.socket.makefile("wb")
        else:
            self.process = subprocess.Popen([str(RELEASE / "p2pshare-engine")],
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            self.reader, self.writer = self.process.stdout, self.process.stdin
        def read():
            for line in self.reader:
                self.events.put(json.loads(line))
        self.reader_thread = threading.Thread(target=read, daemon=True)
        self.reader_thread.start()

    def command(self, **value):
        self.writer.write(json.dumps(value).encode() + b"\n")
        self.writer.flush()

    def event(self, kind, identity=None):
        while True:
            value = self.events.get(timeout=30)
            if value["event"] == "error":
                raise AssertionError(value)
            if value["event"] == kind and (identity is None or value.get("id") == identity):
                if "error" in value:
                    raise AssertionError(value)
                return value

    def close(self):
        if self.thread:
            self.socket.shutdown(socket.SHUT_RDWR)
        self.writer.close()
        if self.process:
            self.process.wait(timeout=10)
        if self.thread:
            self.thread.join(timeout=10)
            assert not self.thread.is_alive(), "JNI runtime failed to stop on disconnect"
        self.reader_thread.join(timeout=10)
        self.reader.close()
        if self.thread:
            self.socket.close()


class Interop(unittest.TestCase):
    def test_android_jni_and_desktop_both_host_roles(self):
        for native_hosts in (True, False):
            with self.subTest(native_hosts=native_hosts), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                android, desktop = Peer(True), Peer(False)
                try:
                    host, guest = (android, desktop) if native_hosts else (desktop, android)
                    host.command(op="host", id="host", ip="127.0.0.1", directory=str(root / "host"))
                    ticket = host.event("response", "host")["value"]
                    guest.command(op="join", id="join", ticket=ticket, directory=str(root / "guest"))
                    guest.event("connected")
                    host.event("connected")
                    source = root / "sample.bin"
                    data = bytes(range(256)) * 32768 + b"last byte"
                    source.write_bytes(data)
                    for sender, receiver in ((android, desktop), (desktop, android)):
                        for attempt in range(2):
                            sender.command(op="send", id="send", path=str(source))
                            received = receiver.event("received")
                            receipt = sender.event("response", "send")["value"]
                            self.assertEqual(Path(received["path"]).read_bytes(), data)
                            self.assertEqual(receipt["payload_bytes"], len(data) if attempt == 0 else 0)
                finally:
                    android.close()
                    desktop.close()


if __name__ == "__main__":
    unittest.main()
