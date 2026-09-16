# P2PShare updates

P2PShare has explicit, user-confirmed updates. It never silently replaces the
application or weakens signature checks.

## Windows

Install `P2PShare-Setup.exe` from GitHub Releases once. In P2PShare choose
**Check for updates → Download update → Install update**. The app accepts only
the expected release asset under this repository, bounds its size, follows only
HTTPS redirects, and verifies GitHub's SHA-256 asset digest before starting the
installer. Source checkouts intentionally continue to use `git pull`.

The current Windows installer is per-user and unsigned. Windows may therefore
show a publisher warning. Code signing remains a release hardening requirement.

## Android

Choose **Check for updates → Download update → Install update**. Android may ask
to allow installs from P2P Share; return to the app and tap **Install update**
again. Before opening Android's installer, P2PShare verifies the download digest,
package name, increasing version code, and exact signing identity. Only the
private update cache is shared through `FileProvider`.

The old CI debug APK cannot transition to a permanent release key in place. The
first signed build requires one manual uninstall/install. Every later signed
update preserves app data as long as the same release identity is retained.

## One-time Android release identity

On a trusted development machine with Java `keytool` and authenticated GitHub
CLI, run:

```bash
python tools/setup_android_signing.py
```

Back up `~/.p2pshare-signing` securely. Never commit, share, or routinely replace
it. The script refuses to generate a replacement when GitHub already contains a
configured identity.

CI tests Rust on Windows/Linux, the desktop renderer and security policy, the
Windows installer, Android unit/emulator interoperability, and both native ABIs.
After every green `main` build, CI publishes the current package version once.
Future releases must bump desktop `version`, Android `versionName`, and Android
`versionCode` together.
