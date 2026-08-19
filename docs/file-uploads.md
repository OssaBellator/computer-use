# Bounded local file uploads

Browser file inputs are a local-data disclosure boundary, not ordinary text entry. The engine therefore models `<input type="file">` with an explicit `upload` capability and keeps file assignment behind `CdpFileUploadController`.

## Security model

Uploads are opt-in and require one or more absolute `allowedRoots`. Before a path is sent to Chromium, the controller:

1. requires an enabled semantic target with stable `backendNodeId` and `upload` capability;
2. canonicalizes configured roots with `realpath()`;
3. canonicalizes each requested file with `realpath()` and requires a regular file;
4. rejects any canonical file outside every canonical allowed root, including symlink escapes;
5. enforces configured file-count and total-byte limits;
6. resolves the backend node and verifies it is actually an enabled `INPUT[type=file]`;
7. rejects multiple files when the browser target does not have `multiple`;
8. uses `DOM.setFileInputFiles` only after those checks; and
9. re-inspects the browser target and verifies the resulting `FileList` count.

```ts
const uploads = new CdpFileUploadController(session, {
  allowedRoots: ['/workspace/approved-uploads'],
  maxFiles: 4,
  maxTotalBytes: 10 * 1024 * 1024,
});

const result = await uploads.upload(fileInputNode, [trustedLocalPath]);
```

`BrowserFileUploadResult` intentionally contains only status, semantic target ID, file count, byte count, and generic failure classes. Configured roots, requested paths, canonical paths, and raw filesystem/protocol error strings are not returned.

## Perception semantics

File inputs remain non-editable and are not promoted to generic activation controls. Their capabilities are explicit:

- `focus` when browser focusable;
- `upload` for `input[type=file]`;
- no `type` capability; and
- no generic `activate` capability merely because the element is a file input.

This lets semantic acquisition use `{ capability: 'upload' }` without conflating local-file disclosure with text entry or button activation.

## Browser-agent and task-program integration

`createCdpBrowserAgentEngine()` enables uploads only when `uploadOptions` are supplied. `uploadFiles()` resolves the semantic target first and rejects ambiguous matches before any local path reaches CDP.

A task program may declare a static upload from literals or trusted task inputs:

```ts
const program: TaskProgram = {
  version: 1,
  entry: 'attach',
  inputs: ['attachmentPath'],
  steps: [
    {
      id: 'attach',
      kind: 'upload',
      target: { name: 'Upload', capability: 'upload' },
      files: [{ input: 'attachmentPath' }],
      next: 'done',
      onFailure: 'failed',
    },
    { id: 'done', kind: 'complete' },
    { id: 'failed', kind: 'fail' },
  ],
};
```

Upload is always classified as `external-side-effect`; the task-program type cannot downgrade it, and the runtime independently hard-codes that classification. With the default risk budget, the step is blocked until an approval callback authorizes it or the caller explicitly raises `maxRisk` to `external-side-effect`.

Task traces record only the step/outcome, semantic target ID, action status, and hashed observations. Trusted local paths are never copied into trace entries.

## Regression coverage

Local unit regressions verify canonical in-root upload, symlink escape rejection before `DOM.setFileInputFiles`, single-file target enforcement, static trusted-input validation, default approval blocking, trace redaction, missing-controller failure, semantic ambiguity rejection, and facade delegation. The Chromium regression verifies that perception exposes `upload`, assigns a real local file through backend-node identity, observes the native `change` event, and reads the expected `File` name/content in the browser while controller result metadata remains path-free.
