# Contributing

This is a reference repository for bounded computer-use architecture. Contributions should preserve the separation between **authority, dispatch, verification, and recovery**.

## Expectations

- Keep adapter identities and generations explicit; do not substitute display labels for target identity.
- Do not convert uncertain dispatch into retry-safe failure.
- Preserve approval boundaries for consequential effects.
- Add focused tests for any changed authority, freshness, retry, verification, or checkpoint behavior.
- Keep platform-specific claims narrower than the validation actually performed.

Typical local checks:

```sh
npm install
npm run typecheck
npm test
npm run test:chromium
```

Use the focused architecture records under [docs/](./docs/) when changing a boundary that already has a written contract.

Security-sensitive reports should follow [SECURITY.md](./SECURITY.md).
