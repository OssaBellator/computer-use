# Verified downloads

Downloads are an explicit opt-in browser capability. Configure an absolute filesystem root when creating the CDP browser-agent facade:

```ts
const engine = createCdpBrowserAgentEngine(page, session, {
  downloadOptions: { downloadPath: '/absolute/sandbox/downloads' },
});
```

`CdpDownloadController` enables Chromium downloads with `Browser.setDownloadBehavior` using `allowAndName`. Chromium therefore stores each file under its opaque CDP download GUID instead of a page-provided filename. The controller deliberately discards the download URL and suggested filename from task-visible state.

A task can verify a declared download-triggering interaction with structural predicates:

```ts
{
  id: 'download',
  kind: 'activate',
  target: { role: 'link', name: 'Export' },
  risk: 'external-side-effect',
  next: 'wait-download',
},
{
  id: 'wait-download',
  kind: 'wait',
  condition: { kind: 'downloads', state: { completedCountAtLeast: 1 } },
  next: 'done',
  onTimeout: 'failed',
}
```

The download observation channel exposes counts, opaque GUIDs, byte progress, lifecycle state, and sequence numbers. It never promotes page URLs or suggested filenames into task control data or traces. `completedPath(guid)` derives a path only from the configured root plus a completed opaque GUID.

The real Chromium regression intentionally supplies `../evil.txt` as the HTML download filename, verifies that the on-disk file is named only by the GUID, checks the downloaded bytes, and confirms the untrusted filename never appears in download state or task traces.
