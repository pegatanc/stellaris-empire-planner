#!/usr/bin/env python3
"""Dev server that refuses to be cached.

    python tools/serve.py [port]

`python -m http.server` sends no Cache-Control, so browsers heuristically cache
the ES modules and the generated data. Editing a module and reloading then keeps
running the old one, which is a confusing way to lose an afternoon. Nothing here
is used in production - GitHub Pages serves the repo with its own headers.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8731
    root = Path(__file__).resolve().parent.parent
    handler = partial(NoCacheHandler, directory=str(root))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving {root} at http://127.0.0.1:{port}/  (no-store)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
