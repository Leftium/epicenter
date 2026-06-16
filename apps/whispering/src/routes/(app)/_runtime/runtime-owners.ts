import { attachAnalytics } from './attach-analytics.svelte';
import { attachDebugCommands } from './attach-debug-commands';
import { attachDesktopEvents } from './attach-desktop-events.svelte';
import { attachGlobalShortcuts } from './attach-global-shortcuts';
import { attachLocalShortcutListener } from './attach-local-shortcut-listener.svelte';
import { attachRecordingOverlay } from './attach-recording-overlay.svelte';
import { attachRecordingRetention } from './attach-recording-retention.svelte';
import { attachTranscriptionConfig } from './attach-transcription-config.svelte';
import { attachSyncIconWithRecorderState } from './sync-icon-with-recorder-state.svelte';
import type { RuntimeOwner } from './types';

export const runtimeOwners = [
	{ attach: attachDebugCommands },
	{ attach: attachAnalytics },
	{ attach: attachLocalShortcutListener },
	{ attach: attachGlobalShortcuts },
	{ attach: attachSyncIconWithRecorderState },
	{ attach: attachRecordingOverlay },
	{ attach: attachTranscriptionConfig },
	{ attach: attachRecordingRetention },
	{ attach: attachDesktopEvents },
] satisfies RuntimeOwner[];
