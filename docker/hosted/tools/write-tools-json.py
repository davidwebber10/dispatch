"""Write /etc/dispatch/tools.json from tools.txt: each tool's name, installed version and purpose.

Run in the image build, as root, with `python3 -I`. A tool that is listed but not installed fails the
build: the list must say only what exists.
Usage: python3 -I write-tools-json.py <tools.txt> <out.json>
"""
import json
import subprocess
import sys
from importlib import metadata


def deb_version(package):
    out = subprocess.run(["dpkg-query", "-W", "-f=${Version}", package], capture_output=True, text=True)
    if out.returncode != 0 or not out.stdout.strip():
        raise SystemExit(f"tools.txt lists {package}, which is not installed")
    return out.stdout.strip()


def py_version(dist):
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        raise SystemExit(f"tools.txt lists the Python package {dist}, which is not installed")


def main(src, dst):
    tools = []
    with open(src, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            name, source, purpose = (part.strip() for part in line.split("|", 2))
            kind, _, pkg = source.partition(":")
            if kind == "deb":
                tools.append({"name": name, "kind": "command" if name != "fonts" else "fonts", "package": pkg, "version": deb_version(pkg), "purpose": purpose})
            elif kind == "py":
                tools.append({"name": name, "kind": "python", "package": pkg, "version": py_version(pkg), "purpose": purpose})
            else:
                raise SystemExit(f"unknown source {source!r} in tools.txt")
    doc = {
        "about": "Document and data tools installed in this Dispatch workspace image. Python libraries import with python3; there is no pip.",
        "python": sys.version.split()[0],
        "tools": tools,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
