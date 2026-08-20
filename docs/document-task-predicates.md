# Document-driven task predicates

Structured reading is useful to policies directly, but deterministic `TaskProgram` workflows also need to wait/assert/branch on document content without falling back to CSS selectors or interactive-node semantics.

Version 0.38 adds a `document` predicate to the task language and a demand-driven structured-document observation channel to `TaskRuntime`.

## Predicate shape

```ts
{
  kind: 'document',
  state: {
    kind: 'heading',
    textIncludes: 'Research result',
    frameId: 'main',
    rendered: true,
    inViewport: true,
    minMatches: 1,
  },
}
```

A document predicate can constrain:

- structured block kind;
- frame ID;
- exact text or text substring;
- exact resolved link URL or URL substring;
- rendered-layout state;
- current viewport intersection;
- minimum number of matching blocks.

`text`, `textIncludes`, `href`, and `hrefIncludes` accept normal `ProgramText`, so values can be supplied through declared task-program inputs.

Predicates compose through the existing `all`, `any`, and `not` forms and can be used by `assert`, `branch`, `wait`, and conditional `complete` steps.

This is intentionally structural rather than selector-based. A research workflow can express “wait until two rendered paragraphs contain Result ready” without depending on a site's class names or DOM selectors.

## Demand-driven observation

Document extraction is materially more expensive than the interaction-only observation channel. `TaskRuntime` therefore scans the program for document predicates and requests structured document snapshots only for programs that actually use them.

A program containing only clicks, typing, browser-state assertions, game control, or other non-document predicates keeps the previous observation path and makes zero `documentContent()` calls.

For a document-aware program, document state participates in task observation fingerprints. Changes to bounded structured text/URLs/metadata therefore count as observable progress during waits and after actions.

## Fail-closed capability behavior

Once a program requires a document predicate, structured reading is mandatory for that run:

- if `TaskRuntimeEngine.documentContent` is absent, observation fails immediately;
- if document extraction throws, that failure propagates to the task observation instead of being converted into an empty document;
- if the engine returns no document snapshot, observation fails.

This avoids a dangerous ambiguity where “the content is not present yet” would otherwise be indistinguishable from “this runtime cannot read document content.”

Frame-local extraction errors remain represented inside `DocumentContentSnapshot.frameErrors`; those are different from total failure of the document channel.

## Capability preflight

`analyzeTaskProgramCapabilities()` now maps every `document` predicate to the `document-content-observation` capability, including predicates nested inside `all` / `any` / `not`.

That keeps planning/preflight consistent with runtime execution: a task program cannot claim to be mechanically runnable on a profile that lacks structured document observation.

## Example wait

```ts
const program = {
  version: 1,
  entry: 'wait-results',
  steps: [
    {
      id: 'wait-results',
      kind: 'wait',
      condition: {
        kind: 'document',
        state: {
          kind: 'paragraph',
          textIncludes: 'Result ready:',
          minMatches: 2,
          rendered: true,
        },
      },
      maxPolls: 20,
      pollIntervalMs: 50,
      next: 'complete',
    },
    {
      id: 'complete',
      kind: 'complete',
      condition: {
        kind: 'document',
        state: { textIncludes: 'Ada' },
      },
    },
  ],
};
```

## Regression coverage

Unit regressions cover:

- kind/frame/text/URL/rendered/viewport/minimum-count matching;
- ProgramText input resolution and validation;
- invalid `minMatches` rejection;
- document-aware capability inference;
- document state in observation fingerprints;
- zero document calls for ordinary programs;
- document calls for document-aware programs;
- fail-closed missing/throwing document channels.

The local Chromium regression launches the standalone raw-CDP browser, inserts two result paragraphs asynchronously, and verifies a real `TaskRuntime` document `wait` followed by a document-conditioned `complete`.

## Next boundaries

Document predicates observe existing bounded content; they do not yet provide:

- extraction of matched block values into task variables;
- table row/column relational predicates;
- article/main-content ranking;
- rich editor selection/range predicates;
- incremental document mutation subscriptions.

Those should remain explicit additions rather than turning document predicates into arbitrary page-side JavaScript.
