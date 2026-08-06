# Contributing

Thanks for helping improve P2PShare. This is experimental networking software,
so correctness, interoperability, and reproducible measurements matter more
than impressive-looking synthetic numbers.

## Before starting

1. Search existing issues and discussions.
2. Open an issue before a large protocol, security, or UI redesign.
3. Keep the direct-only invariant: do not add TURN, upload relays, or hosted file
   storage without prior project agreement.
4. Never commit credentials, signing keys, connection tickets, build outputs,
   or user files.

## Development setup

Desktop and Rust:

```bash
npm ci
npm run build:native
npm run build
cargo test --release --manifest-path native-core/Cargo.toml
```

Android requires JDK 17 and Android SDK 35:

```bash
cd android
./gradlew testDebugUnitTest assembleDebug
```

Set the local Android SDK path in `android/local.properties`; that file is
ignored by Git.

## Pull requests

- Create a focused branch and keep commits understandable.
- Explain the problem, design choice, compatibility impact, and validation.
- Update `ARCHITECTURE.md` when protocol responsibilities or trust boundaries
  change.
- Update `PERFORMANCE.md` when claiming a throughput improvement.
- Include desktop↔Android interoperability results for wire-format changes.
- Keep generated artifacts and platform-specific native binaries out of Git.

CI must pass for the TypeScript/Vite build, Rust tests, and Android tests/build.

## Performance changes

Report at least:

- device and operating system;
- direction and transport topology;
- file size and whether its contents are compressible;
- RTT and observed loss when available;
- warm-up policy and number of runs;
- throughput, CPU use, and any correctness failures.

Do not compare compressed source bytes against uncompressed competitors without
stating both transmitted and original sizes.

## Security reports

Avoid publishing exploitable details or live pairing tickets in a public issue.
Contact the maintainer privately through their GitHub profile until a dedicated
security policy and reporting channel are added.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
