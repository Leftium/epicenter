<script lang="ts">
	import type { Command } from '$lib/commands';
	import { report } from '$lib/report';
	import type { Tauri } from '#platform/tauri';
	import { syncGlobalShortcutsWithSettings } from '$routes/(app)/_layout-utils/register-commands';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import type { Key, KeyBinding, Modifier } from '$lib/tauri/commands';
	import { os } from '#platform/os';
	import {
		isEmptyBinding,
		keyBindingToLabel,
		parseManualBinding,
	} from '$lib/utils/key-binding';
	import RecorderShell from './RecorderShell.svelte';

	// `tauri` is passed non-null from the Tauri-gated global settings page; the
	// recorder drives the rdev backend through it. Recording goes through rdev
	// (not webview keydown) so it can capture the Fn key and physical positions.
	const {
		command,
		placeholder = 'Press a key combination',
		autoFocus = true,
		tauri,
	}: {
		command: Command;
		placeholder?: string;
		autoFocus?: boolean;
		tauri: Tauri;
	} = $props();

	const binding = $derived(deviceConfig.get(`shortcuts.global.${command.id}`));
	const label = $derived(binding ? keyBindingToLabel(binding, os.isApple) : null);

	let open = $state(false);
	let isListening = $state(false);

	// Accumulate the union of every combo the listener reports during a capture,
	// then commit when all keys release (sourced from rdev, not the webview).
	let capturedModifiers = new Set<Modifier>();
	let capturedKeys = new Set<Key>();
	let unlisten: (() => void) | undefined;

	async function startCapture() {
		isListening = true;
		capturedModifiers = new Set();
		capturedKeys = new Set();
		await tauri.globalShortcuts.setCapturing(true);
		unlisten = await tauri.globalShortcuts.listenForCapture((combo) => {
			for (const modifier of combo.modifiers) capturedModifiers.add(modifier);
			for (const key of combo.keys) capturedKeys.add(key);
			// Empty combo = everything released. Commit what we accumulated.
			if (
				isEmptyBinding(combo) &&
				capturedModifiers.size + capturedKeys.size > 0
			) {
				void commitCapture();
			}
		});
	}

	async function stopCapture() {
		isListening = false;
		unlisten?.();
		unlisten = undefined;
		await tauri.globalShortcuts.setCapturing(false);
	}

	async function commitCapture() {
		const next: KeyBinding = {
			modifiers: [...capturedModifiers],
			keys: [...capturedKeys],
		};
		await stopCapture();
		await persist(next);
		open = false;
	}

	async function persist(next: KeyBinding) {
		deviceConfig.set(`shortcuts.global.${command.id}`, next);
		await syncGlobalShortcutsWithSettings();
		report.success({
			title: `Global shortcut set to ${keyBindingToLabel(next, os.isApple)}`,
			description: `Press the shortcut to trigger "${command.title}"`,
		});
	}

	async function clear() {
		await stopCapture();
		deviceConfig.set(`shortcuts.global.${command.id}`, null);
		await syncGlobalShortcutsWithSettings();
		report.success({
			title: 'Global shortcut cleared',
			description: `Set a new shortcut to trigger "${command.title}"`,
		});
	}

	function submitManual(raw: string): boolean {
		const next = parseManualBinding(raw);
		if (!next) {
			report.error({
				title: 'Invalid shortcut',
				description:
					'Try e.g. cmd+shift+d, fn+space, or a modifier-only hold like cmd.',
				cause: {
					name: 'InvalidManualShortcut',
					message: `"${raw}" is not a valid combination.`,
				},
			});
			return false;
		}
		void persist(next).then(() => {
			open = false;
		});
		return true;
	}
</script>

<RecorderShell
	bind:open
	title={command.title}
	{placeholder}
	{autoFocus}
	{label}
	{isListening}
	onStart={() => void startCapture()}
	onStop={() => void stopCapture()}
	onClear={() => void clear()}
	onManualSubmit={submitManual}
	manualInitial={label ?? ''}
	recordHelp="Press a combination. Fn and modifier-only holds work here."
	manualHelp="Type a combination (e.g. cmd+shift+d, fn+space)"
	manualPlaceholder="e.g. cmd+shift+d"
	manualButtonLabel="Type manually"
	listeningHint="Release to set, Esc to cancel"
/>
