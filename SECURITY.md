# Security policy

## Supported versions

P2PShare is experimental and currently supports only the latest commit on the
`main` branch. There are no stable or long-term-support releases yet.

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue. Use
GitHub's **Report a vulnerability** private reporting feature when it is
available for this repository. If private reporting is unavailable, contact the
maintainer privately through the contact options on the
[AagneyVk GitHub profile](https://github.com/AagneyVk).

Include:

- affected commit and platform;
- reproduction steps or a minimal proof of concept;
- expected and observed behavior;
- impact and realistic attack preconditions;
- any suggested mitigation.

Do not include live connection tickets, personal files, private IP history, or
credentials. You should receive an acknowledgment within seven days. Timelines
for validation and remediation depend on severity and maintainer availability.

## Scope notes

- Connection tickets are bearer secrets and must be shared privately.
- Direct-only networking exposes peer IP addresses to the paired peer by design.
- The project has not received an independent security audit.
- The absence of a relay is not a guarantee that endpoint devices are trusted.
