# Navigation containment policy

`CdpNavigationController` can enforce a browser-level navigation boundary independently of semantic target selection.

```ts
const engine = createCdpBrowserAgentEngine(page, session, {
  navigationPolicy: {
    allowedOrigins: ['https://app.example.com', 'https://id.example.com'],
    allowHttp: false,
  },
});
```

Policy is checked twice: before `Page.navigate` and again against the observed final URL after navigation commits. The second check catches redirects that escape the requested allowlisted origin.

Defaults are intentionally conservative:

- `http:` and `https:` are allowed unless disabled;
- `about:` is allowed unless disabled;
- `data:` is blocked unless explicitly enabled;
- unsupported schemes such as `javascript:` and `file:` are blocked;
- usernames/passwords embedded in URLs are blocked unless explicitly enabled;
- when `allowedOrigins` is configured, entries must be exact HTTP(S) origins and both requested and final origins must match.

A policy failure returns `policy-blocked` and never counts as a successful task navigation. Preflight failures do not dispatch `Page.navigate`. A redirect discovered only after commit is reported as blocked so the surrounding task can stop or follow a fixed recovery edge; the controller does not silently invent a new destination.
