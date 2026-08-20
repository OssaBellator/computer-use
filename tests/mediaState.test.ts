import test from 'node:test';
import assert from 'node:assert/strict';
import { observeMediaState } from '../src/browser/mediaState.js';
import { CdpMediaController } from '../src/browser/mediaController.js';

test('media observer returns bounded playback, excludes source URLs, and keeps deepest fullscreen ownership', async () => {
  const calls: string[] = [];
  const session = {
    async send(method: string, params?: Record<string, unknown>): Promise<any> {
      calls.push(method);
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'child' } }] } };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: params?.frameId === 'main' ? 1 : 2 };
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        if (expression.includes("querySelectorAll('audio,video')")) {
          assert.equal(expression.includes('shadowRoot'), true);
          return { result: { type: 'object', objectId: params?.contextId === 1 ? 'media-main' : 'media-child' } };
        }
        if (expression.includes('document.fullscreenElement')) {
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
            tagName: 'video', id: 'hero', ariaLabel: 'Hero video',
            currentSrc: 'https://media.invalid/video.mp4?token=DO_NOT_RETAIN',
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
  assert.equal(snapshot.media[1].durationSeconds, undefined);
  assert.deepEqual(snapshot.activeMedia, snapshot.media[0].identity);
  assert.equal(snapshot.activeMediaCount, 1);
  assert.equal(snapshot.fullscreen.pageState, 'active');
  assert.equal(snapshot.fullscreen.owner?.frameId, 'child');
  assert.equal(snapshot.fullscreen.owner?.backendNodeId, 202);
  assert.equal(snapshot.fullscreen.browserWindowState, 'not-fullscreen');
  assert.equal(snapshot.errors.length, 0);
  assert.equal(JSON.stringify(snapshot).includes('DO_NOT_RETAIN'), false);
  assert.equal(JSON.stringify(snapshot).includes('media.invalid'), false);
  assert.equal(calls.includes('Browser.setPermission'), false);
});

test('media controller does not elevate user activation and verifies native control state', async () => {
  const session = {
    async send(method: string, params?: Record<string, unknown>): Promise<any> {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'media-object' } };
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(String(params?.functionDeclaration).includes('dispatchEvent'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(params ?? {}, 'userGesture'), false);
        return { result: { value: { paused: false, ended: false } } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected ${method}`);
    },
  };
  const controller = new CdpMediaController(session);
  const result = await controller.play({ frameId: 'main', backendNodeId: 42, ordinal: 0, tagName: 'video' });
  assert.equal(result.status, 'verified');
});

test('media controller surfaces native activation rejection instead of manufacturing a user gesture', async () => {
  const session = {
    async send(method: string, params?: Record<string, unknown>): Promise<any> {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'media-object' } };
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(Object.prototype.hasOwnProperty.call(params ?? {}, 'userGesture'), false);
        return { result: { value: { fullscreen: false, rejected: 'NotAllowedError' } } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected ${method}`);
    },
  };
  const controller = new CdpMediaController(session);
  const result = await controller.requestFullscreen({ frameId: 'main', backendNodeId: 42, ordinal: 0, tagName: 'video' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.errorText, 'NotAllowedError');
});

test('generic fullscreen controller verifies non-media elements and treats already-inactive exit as verified', async () => {
  const { CdpFullscreenController } = await import('../src/browser/fullscreenController.js');
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const session = {
    async send(method: string, params?: Record<string, unknown>): Promise<any> {
      calls.push([method, params]);
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 11 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'generic-element' } };
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(String(params?.functionDeclaration).includes('HTMLMediaElement'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(params ?? {}, 'userGesture'), false);
        return { result: { value: { fullscreen: true } } };
      }
      if (method === 'Runtime.evaluate') {
        assert.equal(Object.prototype.hasOwnProperty.call(params ?? {}, 'userGesture'), false);
        return { result: { value: { fullscreen: false } } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected ${method}`);
    },
  };
  const controller = new CdpFullscreenController(session);
  const entered = await controller.requestFullscreen({ frameId: 'main', backendNodeId: 77 });
  assert.equal(entered.status, 'verified');
  assert.equal(entered.backendNodeId, 77);
  const exited = await controller.exitFullscreen('main');
  assert.equal(exited.status, 'verified');
  assert.equal(calls.some(([method]) => method === 'Input.dispatchMouseEvent'), false);
});

test('media observer marks the snapshot truncated when bounded errors are dropped', async () => {
  const session = {
    async send(method: string): Promise<any> {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'child' } }] } };
      }
      if (method === 'Page.createIsolatedWorld') throw new Error('frame unavailable');
      if (method === 'Browser.getWindowForTarget') throw new Error('window unavailable');
      throw new Error(`Unexpected ${method}`);
    },
  };
  const snapshot = await observeMediaState(session, { maxErrors: 1 });
  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.fullscreen.pageState, 'unknown');
});
