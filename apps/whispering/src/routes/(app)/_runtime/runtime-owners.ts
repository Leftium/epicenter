import { dictationCapability } from '$lib/state/dictation-capability.svelte';
import { attachAnalytics } from './attach-analytics.svelte';
import { attachAutoPasteIntent } from './attach-auto-paste-intent.svelte';
import { attachDebugCommands } from './attach-debug-commands';
import { attachDeepLinkNavigation } from './attach-deep-link-navigation';
import { attachGlobalShortcutTriggers } from './attach-global-shortcut-triggers';
import { attachLocalShortcutListener } from './attach-local-shortcut-listener.svelte';
import { attachRecordingOverlay } from './attach-recording-overlay.svelte';
import { attachRecordingRetention } from './attach-recording-retention.svelte';
import { attachShortcutSync } from './attach-shortcut-sync';
import { attachSyncIconWithRecorderState } from './attach-sync-icon-with-recorder-state.svelte';
import { attachUnloadPolicy } from './attach-unload-policy.svelte';
import { attachUpdateCheck } from './attach-update-check';
import type { RuntimeOwner } from './types';

export const runtimeOwners = [
	{ attach: attachDebugCommands },
	{ attach: attachAnalytics },
	{ attach: attachLocalShortcutListener },
	{ attach: attachShortcutSync },
	{ attach: attachGlobalShortcutTriggers },
	{ attach: attachSyncIconWithRecorderState },
	{ attach: attachRecordingOverlay },
	{ attach: attachUnloadPolicy },
	{ attach: attachRecordingRetention },
	{ attach: attachUpdateCheck },
	{ attach: attachDeepLinkNavigation },
	{ attach: attachAutoPasteIntent },
	{ attach: dictationCapability.attach },
] satisfies RuntimeOwner[];
