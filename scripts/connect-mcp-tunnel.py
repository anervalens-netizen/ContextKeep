#!/usr/bin/env python3
"""Configure an existing owner tunnel without credentials in argv or logs.
Obtain the runtime key with the secure OpenAI setup flow, not through chat.
"""
import getpass
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def main() -> None:
    root = Path.home() / ".config/contextkeep"
    if not (root / "mcp-authorization").is_file():
        raise SystemExit("Deploy the ContextKeep MCP local credential first.")
    tunnel = input("Existing OpenAI tunnel ID: ").strip()
    if not re.fullmatch(r"tunnel_[A-Za-z0-9_-]+", tunnel):
        raise SystemExit("Expected a tunnel_... identifier.")
    key = getpass.getpass("OpenAI runtime API key (hidden, never logged): ").strip()
    if not key or any(c.isspace() or c in "\"'\\" for c in key):
        raise SystemExit("Invalid key format; no file was changed.")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = root / "tunnel.env"
    if target.exists() and input("Replace existing tunnel credentials? Type yes: ").strip() != "yes":
        raise SystemExit("Unchanged.")
    fd, temp = tempfile.mkstemp(prefix=".tunnel-env-", dir=root)
    try:
        with os.fdopen(fd, "w") as out:
            out.write(f"CONTROL_PLANE_TUNNEL_ID={tunnel}\nCONTROL_PLANE_API_KEY={key}\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, target)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    env = os.environ.copy()
    env["XDG_RUNTIME_DIR"] = f"/run/user/{os.getuid()}"
    subprocess.run(["systemctl", "--user", "restart", "contextkeep-mcp-tunnel.service"], env=env, check=True)
    print("Credentials saved privately. Check tunnel /readyz before creating the ChatGPT plugin.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        sys.exit("Cancelled.")
