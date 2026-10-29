#!/usr/bin/env python3
"""Loopback-only static server for Swarm Evolution.

Serves an exact allowlist of files. Request paths are never joined onto the
filesystem, so nothing outside the list can be reached.

    python server.py            # http://127.0.0.1:8000/
    python server.py --port 8123
"""

import argparse
import http.server
import pathlib
import socket
import stat
import sys
import threading
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).absolute().parent

JS = "text/javascript; charset=utf-8"
ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/assets/icon.svg": ("assets/icon.svg", "image/svg+xml"),
    "/src/main.js": ("src/main.js", JS),
    "/src/modes.js": ("src/modes.js", JS),
    "/src/sim.js": ("src/sim.js", JS),
    "/src/evolution.js": ("src/evolution.js", JS),
    "/src/genome.js": ("src/genome.js", JS),
    "/src/rng.js": ("src/rng.js", JS),
    "/src/loop.js": ("src/loop.js", JS),
    "/src/render.js": ("src/render.js", JS),
    "/src/input.js": ("src/input.js", JS),
    "/src/audio.js": ("src/audio.js", JS),
    "/src/ui.js": ("src/ui.js", JS),
    "/src/storage.js": ("src/storage.js", JS),
}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; "
    "connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; "
    "form-action 'none'; frame-ancestors 'none'"
)

SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
}

MAX_PATH = 256
MAX_HEADER_BYTES = 16 * 1024
MAX_LINE_BYTES = 4096
MAX_ASSET_BYTES = 1024 * 1024


class HeaderLimitError(ValueError):
    pass


class HeaderReader:
    def __init__(self, stream):
        self.stream, self.size = stream, 0

    def readline(self, limit=-1):
        line = self.stream.readline(min(limit, MAX_LINE_BYTES + 1) if limit >= 0 else MAX_LINE_BYTES + 1)
        self.size += len(line)
        if len(line) > MAX_LINE_BYTES or self.size > MAX_HEADER_BYTES:
            raise HeaderLimitError()
        return line

    def __getattr__(self, name):
        return getattr(self.stream, name)


def read_asset(relative):
    path = ROOT / relative
    for item in (path, *path.parents):
        info = item.lstat()
        if (item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction())
                or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
            raise OSError()
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_ASSET_BYTES:
        raise OSError()
    if not path.resolve().is_relative_to(ROOT.resolve()):
        raise OSError()
    with path.open("rb") as stream:
        body = stream.read(MAX_ASSET_BYTES + 1)
    if len(body) > MAX_ASSET_BYTES:
        raise OSError()
    return body


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "swarm-evolution"
    sys_version = ""
    protocol_version = "HTTP/1.0"
    timeout = 2

    def setup(self):
        super().setup()
        self.command, self.request_version = None, "HTTP/1.0"
        self.rfile = HeaderReader(self.rfile)
        self.header_timer = threading.Timer(self.server.header_deadline, self.abort)
        self.header_timer.daemon = True
        self.header_timer.start()

    def abort(self):
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.connection.close()

    def finish(self):
        self.header_timer.cancel()
        try:
            super().finish()
        except OSError:
            pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except HeaderLimitError:
            self.send_error(431)
        except OSError:
            self.close_connection = True

    def parse_request(self):
        try:
            words = self.raw_requestline.split()
            if len(words) != 3 or words[2] not in {b"HTTP/1.0", b"HTTP/1.1"}:
                self.send_error(400)
                return False
            if not super().parse_request():
                return False
            if self.request_version not in {"HTTP/1.0", "HTTP/1.1"}:
                self.send_error(400)
                return False
            for name in ("Host", "Origin", "Sec-Fetch-Site", "Content-Length", "Content-Type"):
                values = self.headers.get_all(name, [])
                if len(values) > 1 or (name == "Host" and len(values) != 1):
                    self.send_error(400)
                    return False
            length = self.headers.get("Content-Length")
            if self.headers.get_all("Transfer-Encoding") or (length is not None and (len(length) > 10 or not length.isascii() or not length.isdigit())):
                self.send_error(400)
                return False
            return True
        finally:
            self.header_timer.cancel()

    def version_string(self):
        return self.server_version

    def log_message(self, fmt, *args):
        pass

    def _host_ok(self):
        host = (self.headers.get("Host") or "").lower()
        port = self.server.server_address[1]
        if host not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            return False
        origin = self.headers.get("Origin")
        if origin is not None:
            try:
                value = urlsplit(origin)
                if (value.scheme != "http" or value.netloc.lower() != host or value.path or value.query or value.fragment
                        or value.username is not None or value.password is not None or any(c.isspace() for c in origin)):
                    return False
            except ValueError:
                return False
        return self.headers.get("Sec-Fetch-Site") in {None, "none", "same-origin"}

    def _send(self, status, body=b"", ctype="text/plain; charset=utf-8", head=False):
        self.request_version = "HTTP/1.0"
        self.send_response_only(status)
        self.send_header("Server", self.server_version)
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if status == 405:
            self.send_header("Allow", "GET, HEAD")
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        if not head and body:
            try:
                self.wfile.write(body)
            except OSError:
                pass

    def send_error(self, code, message=None, explain=None):
        self._send(code, b'{"error":"Request rejected."}\n', "application/json; charset=utf-8", head=self.command == "HEAD")

    def _serve(self, head):
        if not self._host_ok():
            self.send_error(400)
            return
        if self.headers.get("Content-Length") not in {None, "0"}:
            self.send_error(400)
            return
        if len(self.path) > MAX_PATH:
            self.send_error(414)
            return
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        route = ROUTES.get(path) if len(path) <= MAX_PATH else None
        if route is None:
            self._send(404, b"Not found\n", head=head)
            return
        rel, ctype = route
        try:
            body = read_asset(rel)
        except OSError:
            self._send(404, b"Not found\n", head=head)
            return
        self._send(200, body, ctype, head=head)

    def do_GET(self):
        self._serve(head=False)

    def do_HEAD(self):
        self._serve(head=True)

    def _reject(self):
        if not self._host_ok():
            self.send_error(400)
        else:
            self._send(405, b"Method not allowed\n")

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _reject


class LocalServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, port, max_connections=16, header_deadline=5):
        self.slots = threading.BoundedSemaphore(max_connections)
        self.header_deadline = header_deadline
        super().__init__(("127.0.0.1", port), Handler)

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.allow_reuse_address = False
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, request, address):
        pass


def make_server(port=8000, *, max_connections=16, header_deadline=5):
    if type(max_connections) is not int or not 1 <= max_connections <= 64 or not 0 < header_deadline <= 15:
        raise ValueError("Unsupported server limits.")
    return LocalServer(port, max_connections, header_deadline)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve Swarm Evolution on 127.0.0.1 only.")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)
    if not (1024 <= args.port <= 65535):
        parser.error("port must be between 1024 and 65535")
    try:
        httpd = make_server(args.port)
    except OSError:
        print("Could not start the local server. Check the port and permissions.", file=sys.stderr)
        return 2
    print(f"Swarm Evolution at http://127.0.0.1:{args.port}/  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
