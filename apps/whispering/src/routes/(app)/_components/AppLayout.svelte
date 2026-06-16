<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Dialog from '@epicenter/ui/dialog';
	import { toast } from '@epicenter/ui/sonner';
	// import { extension } from '@epicenter/extension';
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { commandCallbacks } from '$lib/commands';
	import { os } from '#platform/os';
	import MoreDetailsDialog from '$lib/components/MoreDetailsDialog.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';
	import { services } from '$lib/services';
	import { tauri } from '#platform/tauri';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { syncWindowAlwaysOnTopWithRecorderState } from '../_layout-utils/alwaysOnTop.svelte';
	import { checkForUpdates } from '../_layout-utils/check-for-updates';
	import {
		resetGlobalShortcutsToDefaultIfDuplicates,
		resetLocalShortcutsToDefaultIfDuplicates,
		syncGlobalShortcutsWithSettings,
		syncLocalShortcutsWithSettings,
	} from '../_layout-utils/register-commands';
	import { registerOnboarding } from '../_layout-utils/register-onboarding';
	import { registerAccessibilityPermission } from '../_layout-utils/register-accessibility-permission';
	import { syncIconWithRecorderState } from '../_layout-utils/syncIconWithRecorderState.svelte';

	let cleanupAccessibilityPermission: (() => void) | undefined;
	let cleanupShortcutListener: (() => void) | undefined;
	let shortcutListenerDestroyed = false;

	// Start the rdev global listener (idempotent). rdev::listen cannot tap the
	// keyboard before macOS Accessibility is granted, so we only call this once
	// shortcuts are allowed: on macOS from the accessibility-granted callback, on
	// other desktops at launch. Wayland has no working listener; tell the user.
	async function startGlobalListener() {
		if (!tauri) return;
		const status = await tauri.globalShortcuts.start();
		if (status === 'waylandUnsupported') {
			toast.warning('Global shortcuts unavailable on Wayland', {
				description:
					'Whispering needs an X11 session for global shortcuts. On Wayland, bind them through your desktop environment.',
				duration: Number.POSITIVE_INFINITY,
			});
		}
	}

	onMount(() => {
		// Sync operations - run immediately, these are fast
		window.commands = commandCallbacks;
		window.goto = goto;
		registerOnboarding();
		// On macOS the listener starts when Accessibility is granted (the single
		// gate the whole dictation flow shares); this is its one subscriber.
		cleanupAccessibilityPermission = registerAccessibilityPermission({
			onGranted: () => void startGlobalListener(),
		});

		// One trigger backend per platform: desktop uses the rdev global
		// listener exclusively, the browser uses in-app keydown exclusively.
		// They never both bind on the same platform.
		if (tauri) {
			void tauri.globalShortcuts.startListening().then((unlisten) => {
				// If we were destroyed before the listener resolved, drop it now;
				// otherwise it leaks past unmount and a remount would double-fire.
				if (shortcutListenerDestroyed) unlisten();
				else cleanupShortcutListener = unlisten;
			});
			syncGlobalShortcutsWithSettings();
			resetGlobalShortcutsToDefaultIfDuplicates();

			// Non-macOS desktops have no Accessibility gate, so start the listener
			// now (macOS waits for the grant, above).
			if (!os.isApple) void startGlobalListener();

			// Desktop-only async check - fire and forget
			void checkForUpdates();
		} else {
			syncLocalShortcutsWithSettings();
			resetLocalShortcutsToDefaultIfDuplicates();
		}
	});

	onDestroy(() => {
		cleanupAccessibilityPermission?.();
		shortcutListenerDestroyed = true;
		cleanupShortcutListener?.();
	});

	if (tauri) {
		syncWindowAlwaysOnTopWithRecorderState(tauri);
		syncIconWithRecorderState(tauri);
	}

	$effect(() => {
		const strategy = settings.get('retention.strategy');
		if (strategy === 'keep-forever') return;

		// `keep-none` keeps zero recordings; it maps to a runtime count of 0
		// without ever persisting 0 (the schema enforces `maxCount >= 1`).
		const maxCount =
			strategy === 'keep-none' ? 0 : settings.get('retention.maxCount');

		// Only settled recordings are eligible for pruning. A recording still
		// in the pipeline has `transcription: null`; deleting it would pull the
		// audio blob out from under transcription, which reads it back by id.
		// So `keep-none` deletes each recording once its transcription settles,
		// never before, which is the window the recording needs to be usable.
		const settledIds = recordings.sorted
			.filter((recording) => recording.transcription !== null)
			.map((recording) => recording.id);
		if (settledIds.length <= maxCount) return;

		const idsToDelete = settledIds.slice(maxCount);
		// Delete audio blobs from storage
		services.blobs.audio.delete(idsToDelete);
		// Delete recording metadata from workspace (single-scan bulk)
		recordings.bulkDelete(idsToDelete);
	});

	let { children } = $props();
</script>

<div class="flex flex-1 flex-col gap-2 min-w-0 w-full">
	{@render children()}
</div>

<ConfirmationDialog />
<MoreDetailsDialog />
<UpdateDialog />
