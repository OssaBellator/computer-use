# Bounded visual observation

Semantic DOM/accessibility snapshots are the primary grounding surface, but they cannot represent every meaningful browser state. Canvas applications, paint-only changes, charts, maps, and custom renderers may change without a corresponding semantic node delta.

`CdpVisualObserver` provides a dependency-free CDP screenshot primitive for those cases.

## Capture boundary

`capture()` calls `Page.captureScreenshot` and returns:

- image format and MIME type;
- base64 screenshot bytes;
- decoded byte length;
- SHA-256 fingerprint; and
- PNG dimensions when the image header exposes them.

Capture is bounded by `maxBytes` (8 MiB by default). Invalid crop geometry and invalid JPEG/WebP quality are rejected before browser dispatch.

Screenshot bytes may contain credentials, personal data, or other sensitive page content. The observer intentionally returns them only to its caller and never injects image bytes into `TaskRuntime` traces or semantic fingerprints automatically.

## Visual change verification

`waitForChange(previousSha256)` polls bounded screenshots until the SHA-256 fingerprint differs or the timeout/sample budget expires. Exact image change is useful as an additional verification signal for paint-only applications; callers should still prefer semantic evidence when it exists.

The primitive is intentionally conservative: it does not claim perceptual similarity, OCR, or computer-vision semantics. A later multimodal layer can consume the screenshot while preserving the same bounded capture and provenance contract.

## Regression coverage

Unit regressions cover PNG dimensions/fingerprints, invalid geometry and quality, payload ceilings, visual-change polling, and unchanged budgets. The real Chromium regression paints a canvas, captures it, repaints the same canvas without changing DOM structure, and verifies that the screenshot fingerprint changes.
