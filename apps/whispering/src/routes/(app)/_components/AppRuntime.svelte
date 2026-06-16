<script lang="ts">
	import { toast } from '@epicenter/ui/sonner';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { onDestroy, onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { commandCallbacks } from '$lib/commands';
	import { analytics } from '$lib/operations/analytics';
	import {
		cancelRecording,
		stopManualRecording,
		stopVadRecording,
	} from '$lib/operations/recording';
	import {
		RECORDING_OVERLAY_ACTION,
		RECORDING_OVERLAY_FOCUS_MAIN,
		type RecordingOverlayAction,
		type RecordingOverlayStatus,
	} from '$lib/recording-overlay/events';
	import { services } from '$lib/services';
	import {
		isLocalProviderId,
		PROVIDERS,
	} from '$lib/services/transcription/providers';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { localModel } from '$lib/state/local-model.svelte';
	import { manualRecorder } from '$lib/state/manual-recorder.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import { settings } from '$lib/state/settings.svelte';
	import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { commands } from '$lib/tauri/commands';
	import { os } from '#platform/os';
	import { recordingOverlay } from '#platform/recording-overlay';
	import { tauri } from '#platform/tauri';
	import { checkForUpdates } from '../_runtime/check-for-updates';
	import { registerAccessibilityPermission } from '../_runtime/register-accessibility-permission';
	import {
		resetGlobalShortcutsToDefaultIfDuplicates,
		resetLocalShortcutsToDefaultIfDuplicates,
		syncGlobalShortcutsWithSettings,
		syncLocalShortcutsWithSettings,
	} from '$lib/operations/shortcuts';
	import { registerOnboarding } from '../_runtime/register-onboarding';
	import { syncIconWithRecorderState } from '../_runtime/syncIconWithRecorderState.svelte';

	// Headless component: the single, stable owner of everything that starts when
	// Whispering starts. It mounts once at the session root, outside the
	// responsive nav branch, so crossing a layout breakpoint never re-runs any of
	// this. That is the whole point: "once per launch" is structural here, not a
	// guarded flag.

	let cleanupAccessibilityPermission: (() => void) | undefined;
	let cleanupShortcutListener: (() => void) | undefined;
	let shortcutListenerDestroyed = false;
	let unlistenNavigate: UnlistenFn | undefined;
	let unlistenLocalModel: UnlistenFn | undefined;
	let unlistenOverlayAction: UnlistenFn | undefined;
	let unlistenOverlayFocus: UnlistenFn | undefined;

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

	// Single source of truth for what the overlay should show: the active
	// recorder, with manual taking precedence over VAD so the two can never
	// fight over the one overlay window if both are briefly non-idle. Both the
	// sync effect and the action handler in onMount read this, so the precedence
	// rule lives in exactly one place. `null` when idle.
	const overlayStatus = $derived.by((): RecordingOverlayStatus | null => {
		if (manualRecorder.state === 'RECORDING')
			return { mode: 'manual', state: 'RECORDING' };
		if (
			vadRecorder.state === 'LISTENING' ||
			vadRecorder.state === 'SPEECH_DETECTED'
		)
			return { mode: 'vad', state: vadRecorder.state };
		return null;
	});

	// Recorder-window mirror (desktop only): the tray icon tracks the active
	// recorder state.
	if (tauri) {
		syncIconWithRecorderState(tauri);
	}

	// In-app (local) keydown shortcut listener. Runs on every platform; the
	// desktop global backend is separate and started below.
	$effect(() => {
		const unlisten = services.localShortcutManager.listen();
		return () => unlisten();
	});

	// Log app started once on mount.
	$effect(() => {
		analytics.logEvent({ type: 'app_started' });
	});

	// Mirror the active recorder into the overlay window. On web the seam is a
	// no-op.
	$effect(() => {
		recordingOverlay.sync(overlayStatus);
	});

	// Push the ambient transcription config to Rust whenever it changes. Rust
	// owns the resident model lifecycle (cache, preload, eviction) and resolves
	// the model name against its models directory; the FE just mirrors the
	// current settings on a single channel.
	// - Drift in (engine, modelName) triggers a background preload.
	// - Other field changes (language, prompt, unloadPolicy) take effect on the
	//   next transcription with no reload.
	// Fires once on mount (per local engine) and on every subsequent change.
	$effect(() => {
		if (!tauri) return;
		const service = settings.get('transcription.service');
		if (!isLocalProviderId(service)) return;

		const modelName = deviceConfig.get(PROVIDERS[service].modelConfigKey);
		if (!modelName) return;

		const language = settings.get('transcription.language');
		const prompt = settings.get('transcription.prompt');
		void commands
			.setTranscriptionConfig({
				engine: service,
				modelName,
				language: language === 'auto' ? null : language,
				initialPrompt: prompt || null,
				unloadPolicy: deviceConfig.get('transcription.localModelUnloadPolicy'),
			})
			.catch((err) => {
				console.error('Failed to push transcription config to Rust:', err);
			});
	});

	// Retention pruning: keep at most `maxCount` settled recordings.
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

	onMount(() => {
		// Expose imperative helpers for debugging and deep links.
		window.commands = commandCallbacks;
		window.goto = goto;

		// Cross-platform startup facts.
		registerOnboarding();
		// On macOS the listener starts when Accessibility is granted (the single
		// gate the whole dictation flow shares); this is its one subscriber.
		cleanupAccessibilityPermission = registerAccessibilityPermission({
			onGranted: () => void startGlobalListener(),
		});

		// One trigger backend per platform: desktop uses the rdev global listener
		// exclusively, the browser uses in-app keydown exclusively. They never
		// both bind on the same platform.
		if (tauri) {
			void tauri.globalShortcuts.startListening().then((unlisten) => {
				// If the session root was torn down (e.g. navigating out of the app
				// group) before this resolved, drop the listener now so it can't leak
				// past teardown. This owner mounts once and never remounts, so there
				// is no remount race to guard, only this teardown one.
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

			// Listen for navigation from other windows and subscribe to the
			// local-model lifecycle so any consumer (`localModel.isBusy`, etc.) can
			// react to load / inference / eviction events.
			void (async () => {
				unlistenNavigate = await listen<{ path: string }>(
					'navigate-main-window',
					(event) => {
						goto(event.payload.path);
					},
				);
				// Route overlay button clicks against the live recorder state rather
				// than the overlay's payload: a click can race a state change, so we
				// act on `overlayStatus` (derived from the recorder that is actually
				// active), not on what the overlay thought it was showing.
				unlistenOverlayAction = await listen<RecordingOverlayAction>(
					RECORDING_OVERLAY_ACTION,
					(event) => {
						if (!overlayStatus) return;
						if (overlayStatus.mode === 'manual') {
							if (event.payload === 'cancel') void cancelRecording();
							else void stopManualRecording();
							return;
						}
						// VAD only supports stopping, never cancelling. Ignore a stale
						// cancel (e.g. a manual cancel that lands just as VAD starts).
						if (event.payload === 'stop') void stopVadRecording();
					},
				);
				// Clicking the overlay pill body asks the main window to come forward.
				unlistenOverlayFocus = await listen(RECORDING_OVERLAY_FOCUS_MAIN, () => {
					const mainWindow = getCurrentWindow();
					void (async () => {
						await mainWindow.show();
						await mainWindow.unminimize();
						// setFocus often rejects on macOS; the show/unminimize above is
						// what actually surfaces the window, so a failure here is fine.
						await mainWindow.setFocus().catch(() => {});
					})();
				});
				unlistenLocalModel = await localModel.attach();
			})();
		} else {
			syncLocalShortcutsWithSettings();
			resetLocalShortcutsToDefaultIfDuplicates();
		}
	});

	onDestroy(() => {
		cleanupAccessibilityPermission?.();
		shortcutListenerDestroyed = true;
		cleanupShortcutListener?.();
		unlistenNavigate?.();
		unlistenOverlayAction?.();
		unlistenOverlayFocus?.();
		unlistenLocalModel?.();
	});
</script>
