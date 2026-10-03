# Security

This repository is a public reference implementation for bounded computer-use architecture.

## Reporting a security issue

Please do **not** disclose suspected vulnerabilities, credentials, private keys, tokens, customer data, or other sensitive material in a public issue.

If you believe you found a security issue:

1. Prefer GitHub's private security-advisory/reporting flow for this repository when available.
2. Otherwise, open a minimal public issue that contains **no exploit payloads, credentials, or sensitive data** and asks for a private contact path.

## Scope

This repository includes research/runtime code, synthetic fixtures, and platform-specific experimental work. A documented safety boundary or test does not imply that every branch, backend, or target platform has received the same validation depth.

In particular:
- experimental pull requests may contain partially validated work;
- npm publication is intentionally disabled;
- no repository content grants permission to perform consequential actions against third-party systems;
- callers remain responsible for authorization, credential handling, deployment controls, and environment-specific validation.
