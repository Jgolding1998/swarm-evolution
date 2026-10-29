"""Tests for the loopback static server. Run: python -m unittest discover -s tests -p "test_*.py" """

import http.client
import contextlib
import io
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.make_server(0)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def request(self, method, path, host=None, body=None, headers=()):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.putrequest(method, path, skip_host=True)
        conn.putheader("Host", host or f"127.0.0.1:{self.port}")
        for name,value in headers:
            conn.putheader(name,value)
        if body is not None:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res, data

    def test_index_and_headers(self):
        res, data = self.request("GET", "/")
        self.assertEqual(res.status, 200)
        self.assertIn(b"Swarm Evolution", data)
        self.assertIn("frame-ancestors 'none'", res.getheader("Content-Security-Policy"))
        self.assertIn("connect-src 'none'", res.getheader("Content-Security-Policy"))
        self.assertEqual(res.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(res.getheader("Referrer-Policy"), "no-referrer")
        self.assertIn("microphone=()", res.getheader("Permissions-Policy"))
        self.assertEqual(res.getheader("Server"), "swarm-evolution")

    def test_module_mime(self):
        res, _ = self.request("GET", "/src/main.js?v=1")
        self.assertEqual(res.status, 200)
        self.assertTrue(res.getheader("Content-Type").startswith("text/javascript"))

    def test_head(self):
        res, data = self.request("HEAD", "/styles.css")
        self.assertEqual(res.status, 200)
        self.assertEqual(data, b"")

    def test_not_allowlisted(self):
        for path in ["/server.py", "/package.json", "/tests/test_server.py", "/src/", "/src",
                     "/../server.py", "/src/../server.py", "/%2e%2e/server.py", "/src/main.js/",
                     "//etc/passwd", "/C:/Windows/win.ini", "/work/", "/tools/bot.js"]:
            res, _ = self.request("GET", path)
            self.assertEqual(res.status, 404, path)

    def test_request_and_header_size_limits(self):
        res,_ = self.request("GET","/?seed="+"a"*300)
        self.assertEqual(res.status,414)
        for headers in ([('X-Long','a'*4097)],[(f'X-{i}','a'*3500) for i in range(5)]):
            res,_ = self.request("GET","/",headers=headers)
            self.assertEqual(res.status,431)
            self.assertIn("connect-src 'none'",res.getheader("Content-Security-Policy"))

    def test_ambiguous_headers_and_request_bodies_are_rejected(self):
        for headers in ([('Host',f'127.0.0.1:{self.port}')],[('Origin','null'),('Origin','null')],
                        [('Content-Length','0'),('Content-Length','0')],[('Transfer-Encoding','chunked')]):
            self.assertEqual(self.request("GET","/",headers=headers)[0].status,400)
        self.assertEqual(self.request("GET","/",body=b"x")[0].status,400)

    def test_origin_and_fetch_site_are_checked(self):
        for origin in ('null','https://127.0.0.1:'+str(self.port),f'http://127.0.0.1:{self.port}/',f'http://localhost:{self.port}'):
            self.assertEqual(self.request("GET","/",headers=[('Origin',origin)])[0].status,400)
        for site in ('cross-site','same-site'):
            self.assertEqual(self.request("GET","/",headers=[('Sec-Fetch-Site',site)])[0].status,400)
        self.assertEqual(self.request("GET","/",headers=[('Origin',f'http://127.0.0.1:{self.port}'),('Sec-Fetch-Site','same-origin')])[0].status,200)

    def test_protocol_errors_are_generic_and_hardened(self):
        res,body=self.request("PRIVATE_CANARY","/")
        self.assertEqual(res.status,501)
        self.assertNotIn(b'PRIVATE_CANARY',body)
        self.assertNotIn(b'Python',body)
        self.assertEqual(res.getheader('Server'),'swarm-evolution')
        self.assertEqual(res.getheader('X-Frame-Options'),'DENY')
        with socket.create_connection(('127.0.0.1',self.port),timeout=2) as connection:
            connection.sendall(b'GET /\r\n')
            response=connection.recv(4096)
        self.assertTrue(response.startswith(b'HTTP/1.0 400'))
        self.assertIn(b'Content-Security-Policy:',response)

    def test_request_queries_are_not_logged(self):
        output=io.StringIO()
        with contextlib.redirect_stderr(output),contextlib.redirect_stdout(output):
            self.request('GET','/?seed=PRIVATE_QUERY_CANARY')
            self.request('PRIVATE_METHOD_CANARY','/')
        self.assertEqual(output.getvalue(),'')

    def test_linked_and_reparse_assets_are_not_served(self):
        with tempfile.TemporaryDirectory() as directory:
            base=pathlib.Path(directory)
            root=base/'game'
            root.mkdir()
            outside=base/'fixture.txt'
            outside.write_bytes(b'PRIVATE_FILE_CANARY')
            (root/'index.html').hardlink_to(outside)
            with patch.object(server,'ROOT',root):
                res,body=self.request('GET','/')
                self.assertEqual(res.status,404)
                self.assertNotIn(b'PRIVATE_FILE_CANARY',body)
        with patch.object(pathlib.Path,'is_junction',return_value=True,create=True):
            self.assertEqual(self.request('GET','/')[0].status,404)

    def test_trickling_headers_have_a_total_deadline(self):
        httpd=server.make_server(0,header_deadline=0.25)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True)
        thread.start()
        try:
            with socket.create_connection(httpd.server_address,timeout=1) as connection:
                start=time.monotonic()
                connection.sendall(b'GET / HTTP/1.1\r\nX-Drip: ')
                for _ in range(12):
                    try: connection.sendall(b'a')
                    except OSError: break
                    time.sleep(0.04)
                try: data=connection.recv(1024)
                except OSError: data=b''
                self.assertEqual(data,b'')
                self.assertLess(time.monotonic()-start,1.2)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_saturated_connections_are_closed_and_capacity_recovers(self):
        httpd=server.make_server(0,max_connections=1,header_deadline=0.5)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True)
        thread.start()
        first=socket.create_connection(httpd.server_address,timeout=2)
        try:
            first.sendall(b'GET / HTTP/1.1\r\n')
            deadline=time.monotonic()+1
            while httpd.slots._value and time.monotonic()<deadline: time.sleep(0.005)
            self.assertEqual(httpd.slots._value,0)
            with socket.create_connection(httpd.server_address,timeout=1) as second:
                second.sendall(b'GET / HTTP/1.0\r\n\r\n')
                try: data=second.recv(1024)
                except OSError: data=b''
                self.assertEqual(data,b'')
            first.close()
            deadline=time.monotonic()+1
            while not httpd.slots._value and time.monotonic()<deadline: time.sleep(0.005)
            connection=http.client.HTTPConnection(*httpd.server_address,timeout=2)
            connection.request('GET','/')
            self.assertEqual(connection.getresponse().status,200)
            connection.close()
        finally:
            first.close()
            httpd.shutdown()
            httpd.server_close()

    def test_bad_host_rejected(self):
        res, _ = self.request("GET", "/", host="evil.example")
        self.assertEqual(res.status, 400)
        res, _ = self.request("GET", "/", host=f"localhost:{self.port}")
        self.assertEqual(res.status, 200)

    def test_methods(self):
        for m in ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]:
            res, _ = self.request(m, "/", body=b"x")
            self.assertEqual(res.status, 405, m)

    def test_allowlist_matches_shipped_files(self):
        listed = {rel for rel, _ in server.ROUTES.values()}
        shipped = {p.relative_to(ROOT).as_posix() for p in (ROOT / "src").glob("*.js")}
        shipped |= {"index.html", "styles.css", "assets/icon.svg"}
        self.assertEqual(listed, shipped)
        for rel in listed:
            self.assertTrue((ROOT / rel).is_file(), rel)

    def test_idle_connection_times_out(self):
        import socket
        import time
        old = server.Handler.timeout
        server.Handler.timeout = 0.5
        try:
            sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            sock.sendall(b"GET / HTTP/1.1\r\n")  # never finish the request
            start = time.monotonic()
            data = sock.recv(1024)
            self.assertEqual(data, b"")
            self.assertLess(time.monotonic() - start, 4)
            sock.close()
        finally:
            server.Handler.timeout = old

    def test_binds_loopback_only(self):
        self.assertEqual(self.httpd.server_address[0], "127.0.0.1")

    def test_startup_failure_has_a_controlled_nonzero_exit(self):
        result = subprocess.run(
            [sys.executable, str(ROOT / "server.py"), "--port", str(self.port)],
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr.strip(), "Could not start the local server. Check the port and permissions.")


if __name__ == "__main__":
    unittest.main()
