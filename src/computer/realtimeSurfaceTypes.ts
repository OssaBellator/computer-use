import type { ComputerEnvironmentKind, ComputerSurfaceRef } from './environmentAdapter.js';

export const REALTIME_INPUT_KINDS = ['keyboard', 'pointer', 'relative-pointer', 'wheel', 'controller'] as const;
export type RealtimeInputKind = typeof REALTIME_INPUT_KINDS[number];
export interface RealtimeSurfaceDescriptor { adapterId: string; environment: ComputerEnvironmentKind; supportedInputs: readonly RealtimeInputKind[]; controllerControls?: readonly string[]; media?: { observePlayback?: boolean; observePosition?: boolean; observeDuration?: boolean; setPlayback?: boolean; setVolume?: boolean; setMute?: boolean; fullscreen?: boolean } }
export interface RealtimeInputOwnershipState { focused: boolean; inputOwnerId: string; captureOwnerId: string; sessionOwnerId: string; rendererOwnerId?: string; deviceOwnerId?: string }
export interface RelativePointerCaptureState { active: boolean; generation: number; ownerId?: string }
export interface RealtimeSurfaceState { surface: ComputerSurfaceRef & { generation: number }; captureGeneration: number; ownership: RealtimeInputOwnershipState; relativePointer: RelativePointerCaptureState }
export interface RealtimeSurfaceLease { surface: ComputerSurfaceRef & { generation: number }; captureGeneration: number; ownership: RealtimeInputOwnershipState; relativePointerGeneration: number }
export interface RealtimeVisualBounds { x: number; y: number; width: number; height: number }
export interface RealtimeVisualCaptureLimits { maxPixels: number; maxBytes: number }
export interface RealtimeVisualCaptureRequest { surface: ComputerSurfaceRef & { generation: number }; captureGeneration: number; bounds?: RealtimeVisualBounds; limits: RealtimeVisualCaptureLimits }
export interface RealtimeVisualCapture { surface: ComputerSurfaceRef & { generation: number }; captureGeneration: number; frameId: string; timestampMs: number; sequence: number; width: number; height: number; byteLength: number; droppedBefore: number; truncated: boolean; data: Uint8Array }
export interface RealtimeTemporalSample extends RealtimeVisualCapture { order: number }
export interface RealtimeTemporalObservation { surface: ComputerSurfaceRef & { generation: number }; captureGeneration: number; samples: readonly RealtimeTemporalSample[]; droppedSamples: number; truncated: boolean }
export interface RealtimeTemporalObservationRequest { maxSamples: number; bounds?: RealtimeVisualBounds; limits: RealtimeVisualCaptureLimits }
export type RealtimeKeyboardInput = { kind: 'keyboard'; action: 'down' | 'up' | 'press'; key: string };
export type RealtimePointerInput = { kind: 'pointer'; action: 'move' | 'down' | 'up'; x?: number; y?: number; button?: 'left' | 'middle' | 'right' | 'back' | 'forward' };
export type RealtimeRelativePointerInput = { kind: 'relative-pointer'; dx: number; dy: number };
export type RealtimeWheelInput = { kind: 'wheel'; deltaX: number; deltaY: number };
export type RealtimeControllerInput = { kind: 'controller'; control: string; value: number };
export type RealtimeInput = RealtimeKeyboardInput | RealtimePointerInput | RealtimeRelativePointerInput | RealtimeWheelInput | RealtimeControllerInput;
export type RealtimeInputDispatchState = 'not-dispatched' | 'dispatched-once' | 'unknown';
export interface RealtimeInputDispatchResult { dispatch: RealtimeInputDispatchState }
export type RealtimePlaybackState = 'playing' | 'paused' | 'stopped' | 'buffering' | 'ended' | 'unknown';
export interface RealtimeFullscreenState { active: boolean; ownerId?: string }
export interface RealtimeMediaState { surface: ComputerSurfaceRef & { generation: number }; playback: RealtimePlaybackState; positionMs?: number; durationMs?: number; volume?: number; muted?: boolean; fullscreen: RealtimeFullscreenState }
export type RealtimeMediaCommand = { kind: 'playback'; state: 'playing' | 'paused' | 'stopped' } | { kind: 'volume'; volume: number } | { kind: 'mute'; muted: boolean };
export interface RealtimeMediaControlResult { localMediaEffect: 'applied' | 'not-applied' | 'unknown'; externalPublicationEffect: 'not-attempted'; state?: RealtimeMediaState }
export interface RealtimeSurfaceAdapter { readonly descriptor: RealtimeSurfaceDescriptor; inspectSurface(surface: ComputerSurfaceRef): Promise<RealtimeSurfaceState>; captureVisual(request: RealtimeVisualCaptureRequest): Promise<RealtimeVisualCapture>; dispatchInput(surface: ComputerSurfaceRef, input: RealtimeInput): Promise<RealtimeInputDispatchResult>; setRelativePointerCapture?(surface: ComputerSurfaceRef, active: boolean): Promise<RealtimeSurfaceState>; observeMedia?(surface: ComputerSurfaceRef): Promise<RealtimeMediaState>; controlMedia?(surface: ComputerSurfaceRef, command: RealtimeMediaCommand): Promise<RealtimeMediaControlResult>; setFullscreen?(surface: ComputerSurfaceRef, active: boolean, ownerId: string): Promise<RealtimeMediaState> }
export class RealtimeSurfaceError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = 'RealtimeSurfaceError'; } }
export class RealtimeInputDispatchError extends RealtimeSurfaceError { constructor(readonly dispatch: RealtimeInputDispatchState, message: string, readonly cause?: unknown) { super('input-dispatch-uncertain', message); this.name = 'RealtimeInputDispatchError'; } }
