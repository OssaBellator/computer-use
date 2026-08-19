# Roving composite keyboard navigation

Roving-tabindex widgets keep DOM focus on one member at a time while Arrow keys move focus among sibling members. Typical examples include tablists, menus, toolbars, radio groups, trees, and grids.

The interaction model now records two pieces of browser-observed structure for these widgets:

- `tabIndex`, including negative values such as `-1` used by inactive roving members.
- `compositeOwnerStructuralId`, the structural identity of the nearest owning ARIA composite.

## Why ownership matters

Pure geometry is not enough to infer Arrow-key navigation safely. A button outside a tablist can be physically closer to the focused tab than the next tab. Without composite ownership, a geometric prior can therefore predict an impossible or semantically wrong transition.

For speculative Arrow edges, the graph builder now partitions nodes into directional spaces:

- members of a composite can target only members with the same composite owner;
- ordinary controls do not speculate into composite members;
- members with `tabindex="-1"` remain eligible Arrow destinations even when they are not directly tabbable or clickable;
- `aria-activedescendant` owners remain outside option-level Arrow space and continue to use zero-input state-anchor bridges to the active descendant.

Observed browser transitions still override speculative geometry through `DirectionalTopology`. The composite boundary is therefore a safety constraint on unobserved hypotheses, not a replacement for empirical learning.

## Snapshot roles

The DOM snapshot includes common ARIA composite owners (`grid`, `listbox`, `menu`, `menubar`, `radiogroup`, `tablist`, `toolbar`, `tree`, and `treegrid`) plus common navigable members (`gridcell`, column/row headers, menu item variants, options, radios, tabs, and tree items).

Composite ownership is stored as structural identity rather than the stabilized backend-node ID. This keeps sibling membership comparable after CDP identity enrichment changes each node's primary `id` to `backend:<nodeId>`.

## Validation

Unit regressions in `tests/graphBuilder.test.ts` cover:

- refusing to escape a roving widget for a visually closer outside control;
- refusing to speculate from ordinary controls into a roving widget;
- retaining non-clickable, `tabindex=-1` grid cells as Arrow destinations.

`tests/integration/rovingCompositeSmoke.test.mjs` launches local Chromium, extracts real tablist metadata, and verifies that acquisition reaches the next tab with a single successful `ArrowRight` edge and no replanning.

Run locally with:

```bash
npm test
npm run test:chromium
```

Set `CHROMIUM_BIN=/path/to/chromium` if Chromium is not installed at `/usr/bin/chromium`.
