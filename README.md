# Semantic Browser Interaction Engine

A TypeScript foundation for closed-loop browser interaction research and testing.

The project models a page as a semantic/spatial interaction graph, plans across keyboard/pointer-style actions, and executes pointer movement through a bounded virtual touchpad model with deterministic minimum-jerk trajectories.

## Scope

This project intentionally uses standard browser automation input primitives instead of JavaScript `dispatchEvent()` calls. That makes interaction suitable for realistic browser testing and HCI experiments, but it does **not** claim that automated input is indistinguishable from physical hardware input or provide anti-bot bypass logic.

## Current foundation

- `InteractionNode` / `InteractionEdge` domain model
- weighted path search for interaction plans
- directional spatial scoring with alignment + uncertainty penalties
- frame-aware DOM snapshot extraction with open-shadow-root traversal
- safe target-point geometry helpers
- deterministic minimum-jerk trajectories and Fitts-style duration prior
- bounded virtual touchpad finger state separate from viewport cursor state
- Playwright-backed browser input adapter
- pointer controller that handles virtual finger lifts/recentering
- unit tests for graph navigation and touchpad/pointer behavior

## Install

```bash
npm install
```

## Validate

```bash
npm run typecheck
npm test
npm run build
```

## Architecture

```text
semantic goal
    |
    v
DOM / frame snapshot
    |
    v
interaction graph ---> planner
                        |
                +-------+-------+
                |               |
             keyboard        pointer
                                |
                         motor trajectory
                                |
                         virtual touchpad
                                |
                         browser adapter
                                |
                              page
                                |
                            observe/replan
```

## Next implementation slices

1. CDP DOMSnapshot + Accessibility-tree identity fusion using stable backend/AX node IDs.
2. Observed focus-topology learner (`Tab` / `Shift+Tab` followed by focus observation).
3. A* planner with explicit modality-switch, scroll, failure, and uncertainty costs.
4. Occlusion-aware hit testing based on `elementsFromPoint()` / paint order.
5. Closed-loop action verification and replanning after focus, click, scroll, and typing actions.
6. Calibration profiles for virtual touchpad dimensions and deterministic pointer gain curves.
