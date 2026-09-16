"""One-time Android release identity setup for P2PShare.

Requires Java keytool and an authenticated GitHub CLI. The private key stays in
the user's home directory and encrypted GitHub Actions secrets; it is never
written to the repository. Existing identity is always reused, never rotated.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess

REPOSITORY = "AagneyVk/p2pshare-direct"
PREFIX = "P2PSHARE_ANDROID_"

subprocess.run(["gh", "auth", "status"], check=True)
directory = Path.home() / ".p2pshare-signing"
directory.mkdir(mode=0o700, exist_ok=True)
keystore = directory / "release.jks"
settings = directory / "credentials.json"

if keystore.exists() != settings.exists():
    raise SystemExit("Incomplete signing backup; recover it before continuing.")

if not keystore.exists():
    configured = subprocess.run(
        ["gh", "secret", "list", "--repo", REPOSITORY, "--json", "name"],
        check=True, capture_output=True, text=True,
    )
    if any(item["name"] == PREFIX + "KEYSTORE_B64" for item in json.loads(configured.stdout)):
        raise SystemExit("GitHub already has a release key. Restore the original local backup; do not replace it.")
    credentials = {"password": secrets.token_urlsafe(32), "alias": "p2pshare"}
    descriptor = os.open(settings, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(credentials, output)
    environment = dict(os.environ, P2PSHARE_SIGNING_PASSWORD=credentials["password"])
    subprocess.run([
        "keytool", "-genkeypair", "-keystore", str(keystore), "-storetype", "JKS",
        "-alias", credentials["alias"], "-keyalg", "RSA", "-keysize", "3072",
        "-validity", "10000", "-dname", "CN=P2PShare",
        "-storepass:env", "P2PSHARE_SIGNING_PASSWORD",
        "-keypass:env", "P2PSHARE_SIGNING_PASSWORD",
    ], env=environment, check=True)

credentials = json.loads(settings.read_text(encoding="utf-8"))
environment = dict(os.environ, P2PSHARE_SIGNING_PASSWORD=credentials["password"])
certificate = subprocess.run([
    "keytool", "-exportcert", "-keystore", str(keystore), "-alias", credentials["alias"],
    "-storepass:env", "P2PSHARE_SIGNING_PASSWORD",
], env=environment, check=True, capture_output=True).stdout

values = {
    PREFIX + "KEYSTORE_B64": base64.b64encode(keystore.read_bytes()).decode(),
    PREFIX + "KEYSTORE_PASSWORD": credentials["password"],
    PREFIX + "KEY_ALIAS": credentials["alias"],
    PREFIX + "KEY_PASSWORD": credentials["password"],
    PREFIX + "SIGNING_SHA256": hashlib.sha256(certificate).hexdigest(),
}
for name, value in values.items():
    subprocess.run(["gh", "secret", "set", name, "--repo", REPOSITORY], input=value, text=True, check=True)

print("P2PShare Android signing is configured. Back up ~/.p2pshare-signing securely; never share or commit it.")
