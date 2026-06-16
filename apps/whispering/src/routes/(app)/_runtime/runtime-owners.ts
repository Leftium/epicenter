/**
 * Owns the app-session runtime registry: each owner starts once because
 * `AppRuntime` mounts once at the app layout root.
 */

import { shortcuts } from '#platform/shortcuts';
import { permissions } from '$lib/state/permissions.svelte';
import { appStartedRuntime } from './app-started.js';
import { debugGlobalsRuntime } from './debug-globals.js';
import { nativeRuntime } from './native-runtime.js';
import { recordingOverlayRuntime } from './recording-overlay.svelte.js';
import { retentionPruningRuntime } from './retention-pruning.svelte.js';
import { syncIconWithRecorderStateRuntime } from './sync-icon-with-recorder-state.svelte.js';
import { transcriptionConfigRuntime } from './transcription-config.svelte.js';

export type RuntimeOwner = {
	attach(): void | (() => void);
};

export const runtimeOwners: RuntimeOwner[] = [
	debugGlobalsRuntime,
	appStartedRuntime,
	permissions,
	shortcuts,
	syncIconWithRecorderStateRuntime,
	recordingOverlayRuntime,
	transcriptionConfigRuntime,
	retentionPruningRuntime,
	nativeRuntime,
];
