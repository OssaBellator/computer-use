# Multi-tab and popup target lifecycle

`CdpTargetController` models browser tabs/popups as structural CDP targets without retaining page URL/title text in task-visible state.

The task runtime adds two bounded topology actions:

- `open-tab`: creates a new page target from a literal or declared trusted task input. The destination is checked by the same `NavigationPolicy` used for top-level navigation.
- `close-latest-tab`: closes only the latest **unattached** page target. Attached targets are protected by default so a generic recovery step cannot tear down the primary page/session.

Target predicates expose only counts:

```ts
{
  kind: 'targets',
  state: { pageCountAtLeast: 2, unattachedPageCountAtLeast: 1 },
}
```

The target monitor keeps opaque target IDs, target type, attachment/opener relationships, and a monotonic sequence. It deliberately does not retain target URLs or titles. Task traces record only action outcomes and state fingerprints; trusted tab destinations do not appear in trace entries.

## Example

```ts
const program = {
  version: 1,
  entry: 'open-help',
  inputs: ['helpUrl'],
  steps: [
    { id: 'open-help', kind: 'open-tab', url: { input: 'helpUrl' }, next: 'wait-open' },
    {
      id: 'wait-open', kind: 'wait',
      condition: { kind: 'targets', state: { unattachedPageCountAtLeast: 1 } },
      next: 'close-help', onTimeout: 'failed',
    },
    { id: 'close-help', kind: 'close-latest-tab', next: 'wait-closed' },
    {
      id: 'wait-closed', kind: 'wait',
      condition: { kind: 'not', predicate: { kind: 'targets', state: { unattachedPageCountAtLeast: 1 } } },
      next: 'done', onTimeout: 'failed',
    },
    { id: 'done', kind: 'complete' },
    { id: 'failed', kind: 'fail' },
  ],
};
```

`npm run test:chromium` includes real Chromium regressions for both the direct target controller and the typed task flow.
