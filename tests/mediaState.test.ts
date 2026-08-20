import test from 'node:test';
import assert from 'node:assert/strict';
import { observeMediaState } from '../src/browser/mediaState.js';
import { CdpMediaController } from '../src/browser/mediaController.js';

test('media observer returns bounded playback and deepest fullscreen ownership', async () => {
  const calls: string[] = [];
  const session = {
    async send(method: string, params?: Record<string, unknown>): Promise<any> {
      calls.push(method);
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'child' } }] } };
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: params?.frameId === 'main' ? 1 : 2 };
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        if (expression.includes("querySelectorAll('audio,video')")) {
          return { result: { type: 'object', objectId: params?.contextId === 1 ? 'media-main' : 'media-child' } };
        }
        if (expression === 'document.fullscreenElement') {
          return params?.contextId === 2
            ? { result: { type: 'object', objectId: 'fullscreen-child' } }
            : { result: { type: 'object', subtype: 'null', value: null } };
        }
      }
      if (method === 'Runtime.getProperties') {
        if (params?.objectId === 'media-main') {
          return { result: [
            { name: '0', value: { objectId: 'video-1' } },
            { name: '1', value: { objectId: 'audio-2' } },
          ] };
        }
        return { result: [] };
      }
      if (method === 'DOM.describeNode') {
        const ids: Record<string, number> = { 'video-1': 101, 'audio-2': 102, 'fullscreen-child': 202 };
        return { node: { backendNodeId: ids[String(params?.objectId)] } };
      }
      if (method === 'Runtime.callFunctionOn') {
        if (params?.objectId === 'video-1') {
          return { result: { value: {
            tagName: 'video', id: 'hero', ariaLabel: 'Hero video', currentSrc: 'data:video/test',
            playbackState: 'playing', muted: false, volume: 0.75, currentTimeSeconds: 12,
            durationSeconds: 120, playbackRate: 1.25, visible: true,
          } } };
        }
        if (params?.objectId === 'audio-2') {
          return { result: { value: {
            tagName: 'audio', playbackState: 'paused', muted: true, volume: 1,
            currentTimeSeconds: Number.POSITIVE_INFINITY, durationSeconds: Number.POSITIVE_INFINITY,
            playbackRate: 1, visible: false,
          } } };
        }
        if (params?.objectId === 'fullscreen-child') {
          return { result: { value: { tagName: 'video', id: 'child-video', ariaLabel: 'Child video' } } };
        }
      }
      if (method === 'Browser.getWindowForTarget') return { bounds: { windowState: 'normal' } };
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected ${method}`);
    },
  };

  const snapshot = await observeMediaState(session, { maxTextLength: 64 });
  assert.equal(snapshot.media.length, 2);
  assert.equal(snapshot.media[0].playbackState, 'playing');
  assert.equal(snapshot.media[0].volume, 0.75);
  assert.equal('currentSrc' in snapshot.media[0].identity, false);
  assert.equal(snapshot.media[1].durationSeconds, undefined);
  assert.deepEqual(snapshot.activeMedia, snapshot.media[0].identity);
  assert.equal(snapshot.activeMediaCount, 1);
  assert.equal(snapshot.fullscreen.pageState, 'active');
  assert.equal(snapshot.fullscreen.owner?.frameId, 'child');
  assert.equal(snapshot.fullscreen.owner?.backendNodeId, 202);
  assert.equal(snapshot.fullscreen.browserWindowState, 'not-fullscreen');
  assert.equal(snapshot.errors.length, 0);
  assert.equal(calls.includes('Browser.setPermission'), false);
});

test('media controller uses native element methods without elevating user activation and verifies the result', async () => {
  const sent: Array<[string, Record<string, unknown> | undefined]> = [];
  const session = {
    async send(method: string, params?: Record<string, unknown>): Promise<any> {
      sent.push([method, params]);
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'media-object' } };
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(String(params?.functionDeclaration).includes('dispatchEvent'), false);
        assert.equal(params?.userGesture, undefined);
        return { result: { value: { paused: false, ended: false } } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected ${method}`);
    },
  };
  const controller = new CdpMediaController(session);
  const result = await controller.play({ frameId: 'main', backendNodeId: 42, ordinal: 0, tagName: 'video' });
  assert.equal(result.status, 'verified');
  assert.equal(sent.some(([method]) => method === 'Input.dispatchMouseEvent'), false);
});

test('media controller reports normal browser activation-policy rejection without retry or gesture elevation', async () => {
  let calls = 0;
  const session = {
    async send(method: string, params?: Record<string, unknown>): Promise<any> {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'media-object' } };
      if (method === 'Runtime.callFunctionOn') {
        calls += 1;
        assert.equal(params?.userGesture, undefined);
        return { result: { value: { paused: true, ended: false, rejected: 'NotAllowedError' } } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected ${method}`);
    },
  };
  const controller = new CdpMediaController(session);
  const result = await controller.play({ frameId: 'main', backendNodeId: 42, ordinal: 0, tagName: 'video' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.errorText, 'NotAllowedError');
  assert.equal(calls, 1);
});
