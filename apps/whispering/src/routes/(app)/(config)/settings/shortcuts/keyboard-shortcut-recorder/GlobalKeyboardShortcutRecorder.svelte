<script lang="ts">
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { report } from '$lib/report';
	import type { Tauri } from '$lib/tauri';
	import {
		type Accelerator,
		pressedKeysToAccelerator,
	} from '$lib/utils/accelerator';
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
			if (shortcutValue) {
				const { error: unregisterError } =
					await tauri.globalShortcuts.unregisterCommand({
						accelerator: shortcutValue as Accelerator,
					});

				if (unregisterError) {
					report.error({
						title: 'Failed to unregister shortcut',
						description:
							'Could not unregister the global shortcut. It may already be in use by another application.',
						cause: unregisterError,
					});
				}
			}

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

			const { error: registerError } =
				await tauri.globalShortcuts.registerCommand({
					command,
					accelerator,
				});

			if (registerError) {
				switch (registerError.name) {
					case 'InvalidFormat':
					case 'NoKeyCode':
					case 'MultipleKeyCodes':
					case 'GeneratedInvalid':
						report.error({
							title: 'Invalid shortcut combination',
							description: `The key combination "${keyCombination.join('+')}" is not valid. Please try a different combination.`,
							cause: registerError,
						});
						break;
					default:
						report.error({
							title: 'Failed to register shortcut',
							description:
								'Could not register the global shortcut. It may already be in use by another application.',
							cause: registerError,
						});
						break;
				}
				return;
			}

			deviceConfig.set(`shortcuts.global.${command.id}`, accelerator);

			report.success({
				title: `Global shortcut set to ${accelerator}`,
				description: `Press the shortcut to trigger "${command.title}"`,
			});
		},
		onClear: async () => {
			const { error: unregisterError } =
				await tauri.globalShortcuts.unregisterCommand({
					accelerator: shortcutValue as Accelerator,
				});

			if (unregisterError) {
				report.error({
					title: 'Error clearing global shortcut',
					description: 'Could not clear the global shortcut.',
					cause: unregisterError,
				});
			}

			deviceConfig.set(`shortcuts.global.${command.id}`, null);

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
