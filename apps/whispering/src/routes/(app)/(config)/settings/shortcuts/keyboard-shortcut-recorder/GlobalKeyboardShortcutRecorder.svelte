<script lang="ts">
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { notify } from '$lib/operations/notify';
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
					notify.error({
						title: 'Failed to unregister shortcut',
						description:
							'Could not unregister the global shortcut. It may already be in use by another application.',
						action: { type: 'more-details', error: unregisterError },
					});
				}
			}

			const { data: accelerator, error: acceleratorError } =
				pressedKeysToAccelerator(keyCombination);

			if (acceleratorError) {
				notify.error({
					title: 'Invalid shortcut combination',
					description: `The key combination "${keyCombination.join('+')}" is not valid. Please try a different combination.`,
					action: { type: 'more-details', error: acceleratorError },
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
						notify.error({
							title: 'Invalid shortcut combination',
							description: `The key combination "${keyCombination.join('+')}" is not valid. Please try a different combination.`,
							action: { type: 'more-details', error: registerError },
						});
						break;
					default:
						notify.error({
							title: 'Failed to register shortcut',
							description:
								'Could not register the global shortcut. It may already be in use by another application.',
							action: { type: 'more-details', error: registerError },
						});
						break;
				}
				return;
			}

			deviceConfig.set(`shortcuts.global.${command.id}`, accelerator);

			notify.success({
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
				notify.error({
					title: 'Error clearing global shortcut',
					description: 'Could not clear the global shortcut.',
					action: { type: 'more-details', error: unregisterError },
				});
			}

			deviceConfig.set(`shortcuts.global.${command.id}`, null);

			notify.success({
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
