<script lang="ts">
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { report } from '$lib/report';
	import type { Tauri } from '#platform/tauri';
	import { pressedKeysToAccelerator } from '$lib/utils/accelerator';
	import { syncGlobalShortcutsWithSettings } from '$routes/(app)/_layout-utils/register-commands';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { type PressedKeys } from '$lib/utils/createPressedKeys.svelte';
	import { createKeyRecorder } from './create-key-recorder.svelte';
	import KeyboardShortcutRecorder from './KeyboardShortcutRecorder.svelte';

	// Tauri is passed in non-null from a Tauri-gated parent (the global
	// shortcuts settings page). This component only makes sense on Tauri.
	const {
		command,
		placeholder,
		autoFocus = true,
		pressedKeys,
		tauri,
	}: {
		command: Command;
		placeholder?: string;
		autoFocus?: boolean;
		pressedKeys: PressedKeys;
		tauri: Tauri;
	} = $props();

	const shortcutValue = $derived(
		deviceConfig.get(`shortcuts.global.${command.id}`),
	);

	const keyRecorder = createKeyRecorder({
		pressedKeys,
		onRegister: async (keyCombination: KeyboardEventSupportedKey[]) => {
			const { data: accelerator, error: acceleratorError } =
				pressedKeysToAccelerator(keyCombination);

			if (acceleratorError) {
				report.error({
					title: 'Invalid shortcut combination',
					description: `The key combination "${keyCombination.join('+')}" is not valid. Please try a different combination.`,
					cause: acceleratorError,
				});
				return;
			}

			// Persist, then re-push the full set to the rdev backend. The backend
			// is replace-all, so updating one shortcut means re-syncing the lot.
			deviceConfig.set(`shortcuts.global.${command.id}`, accelerator);
			await syncGlobalShortcutsWithSettings();

			report.success({
				title: `Global shortcut set to ${accelerator}`,
				description: `Press the shortcut to trigger "${command.title}"`,
			});
		},
		onClear: async () => {
			deviceConfig.set(`shortcuts.global.${command.id}`, null);
			await syncGlobalShortcutsWithSettings();

			report.success({
				title: 'Global shortcut cleared',
				description: `Please set a new shortcut to trigger "${command.title}"`,
			});
		},
	});
</script>

<KeyboardShortcutRecorder
	title={command.title}
	{placeholder}
	{autoFocus}
	rawKeyCombination={shortcutValue}
	{keyRecorder}
/>
