/**
 * Intentional public surface for the environment-neutral computer-use runtime.
 *
 * Keep this list curated. Concrete host/backend adapters and implementation
 * cores stay source-internal until their authority/configuration contracts are
 * ready to become package API.
 */
export * from './environmentAdapter.js';
export * from './environmentRegistry.js';
export * from './computerCapabilities.js';
export * from './browserCapabilityBridge.js';
export * from './profileComposition.js';
export * from './computerTask.js';
export * from './computerTaskCheckpoint.js';
export * from './computerTaskRuntime.js';
export * from './composition.js';
export * from './localComputePublic.js';

/**
 * Application-neutral document/editor semantics are public as a deliberate
 * namespace boundary rather than flattening their model vocabulary into the
 * historical browser package surface.
 */
export * as computerDocumentModels from './documentModels.js';
