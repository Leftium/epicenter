<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Dialog from '@epicenter/ui/dialog';
	// import { extension } from '@epicenter/extension';
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { commandCallbacks } from '$lib/commands';
	import { report } from '$lib/report';
	import { os } from '#platform/os';
	import MoreDetailsDialog from '$lib/components/MoreDetailsDialog.svelte';
	import UpdateDialog from '$lib/components/UpdateDialog.svelte';
	import {
		RECORDER_STATE_TO_ICON,
		VAD_STATE_TO_ICON,
	} from '$lib/constants/audio';
	import { services } from '$lib/services';
	import { tauri } from '#platform/tauri';
	import { getSetupReadiness } from '$lib/setup/setup-readiness';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { syncWindowAlwaysOnTopWithRecorderState } from '../_layout-utils/alwaysOnTop.svelte';
	import { checkForUpdates } from '../_layout-utils/check-for-updates';
	import {
		resetGlobalShortcutsToDefaultIfDuplicates,
		resetLocalShortcutsToDefaultIfDuplicates,
		syncGlobalShortcutsWithSettings,
		syncLocalShortcutsWithSettings,
	} from '../_layout-utils/register-commands';
	import { permissions } from '$lib/state/permissions.svelte';
	import { syncIconWithRecorderState } from '../_layout-utils/syncIconWithRecorderState.svelte';

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
			report.warning({
				id: 'wayland-unsupported',
				title: 'Global shortcuts unavailable on Wayland',
				description:
					'Whispering needs an X11 session for global shortcuts. On Wayland, bind them through your desktop environment.',
			});
		}
	}

	onMount(() => {
		// Sync operations - run immediately, these are fast
		window.commands = commandCallbacks;
		window.goto = goto;

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
		shortcutListenerDestroyed = true;
		cleanupShortcutListener?.();
	});

	if (tauri) {
		syncWindowAlwaysOnTopWithRecorderState(tauri);
		syncIconWithRecorderState(tauri);
	}

	// macOS: Accessibility is the single gate for the rdev listener. Start it the
	// moment the grant lands (the permissions owner re-checks on window focus, so
	// returning from System Settings flips this without a restart). `start()` is
	// idempotent, so re-running on the granted→true transition is safe.
	$effect(() => {
		if (!tauri || !os.isApple) return;
		if (permissions.accessibilityGranted) void startGlobalListener();
	});

	// First-run gate. Until this device finishes setup, wall everything except the
	// setup wizard and the Accessibility guide. `canFinish` doubles as the
	// backfill: an existing user upgrading already has a model + permissions +
	// activation, so they are marked done immediately and never see the wall.
	// Once `setup.completed` is true it never flips back, so later breaking your
	// config (clearing a model, losing a grant) does not re-wall you. Wait for the
	// permission probe to settle so a granted user is never bounced mid-check.
	$effect(() => {
		if (permissions.accessibility === 'checking') return;
		if (deviceConfig.get('setup.completed')) return;

		const readiness = getSetupReadiness();
		if (readiness.canFinish) {
			deviceConfig.set('setup.completed', true);
			return;
		}

		const path = page.url.pathname;
		if (path.startsWith('/setup') || path === '/macos-enable-accessibility') {
			return;
		}
		void goto('/setup');
	});

	// macOS: a returning user whose grant broke (e.g. ad-hoc-signed update churns
	// the TCC identity) gets a standing nudge into the re-grant guide. Only after
	// setup is complete (a first-run user is handled by the gate above), only on a
	// real `denied` (never the initial `checking`), and not on a permission surface.
	$effect(() => {
		if (!tauri || !os.isApple) return;
		const path = page.url.pathname;
		const onPermissionSurface =
			path === '/macos-enable-accessibility' || path.startsWith('/setup');
		if (
			permissions.accessibility !== 'denied' ||
			!deviceConfig.get('setup.completed') ||
			onPermissionSurface
		) {
			report.dismiss('accessibility-regrant');
			return;
		}
		report.warning({
			id: 'accessibility-regrant',
			title: 'Accessibility access needed',
			description:
				'Whispering needs Accessibility access to listen for global shortcuts and paste transcripts.',
			action: {
				label: 'View Guide',
				onClick: () => goto('/macos-enable-accessibility'),
			},
		});
	});

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

{#if settings.get('recording.mode') === 'vad'}
	<button
		class="xxs:hidden hover:bg-accent hover:text-accent-foreground h-screen w-screen transform duration-300 ease-in-out"
		onclick={() => commandCallbacks.toggleVadRecording()}
	>
		<span
			style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5));"
			class="text-[48px] leading-none"
		>
			{VAD_STATE_TO_ICON[vadRecorder.state]}
		</span>
	</button>
{:else}
	<button
		class="xxs:hidden hover:bg-accent hover:text-accent-foreground h-screen w-screen transform duration-300 ease-in-out"
		onclick={() => commandCallbacks.toggleManualRecording()}
	>
		<span
			style="filter: drop-shadow(0px 2px 4px rgba(0, 0, 0, 0.5));"
			class="text-[48px] leading-none"
		>
			{RECORDER_STATE_TO_ICON[manualRecorder.state]}
		</span>
	</button>
{/if}

<div class="hidden flex-1 flex-col gap-2 xxs:flex min-w-0 w-full">
	{@render children()}
</div>

<ConfirmationDialog />
<MoreDetailsDialog />
<UpdateDialog />
