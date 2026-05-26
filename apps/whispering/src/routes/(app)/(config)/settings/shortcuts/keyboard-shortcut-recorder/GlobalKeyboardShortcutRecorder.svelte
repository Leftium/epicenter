<script lang="ts">
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { notify } from '$lib/operations/notify';
	import { tauri, type Accelerator } from '$lib/tauri';
	import { deviceConfig } from '$lib/state/device-config.svelte';
	import { type PressedKeys } from '$lib/utils/createPressedKeys.svelte';
	import { createKeyRecorder } from './create-key-recorder.svelte';
	import KeyboardShortcutRecorder from './KeyboardShortcutRecorder.svelte';

	const {
		command,
		placeholder,
		autoFocus = true,
		pressedKeys,
	}: {
		command: Command;
		placeholder?: string;
		autoFocus?: boolean;
		pressedKeys: PressedKeys;
	} = $props();

	const shortcutValue = $derived(
		deviceConfig.get(`shortcuts.global.${command.id}`),
	);

	const keyRecorder = createKeyRecorder({
		pressedKeys,
		// Global shortcuts only exist on Tauri; this component renders only when the parent
		// (a Tauri-gated settings page) is showing. `tauri!` is safe inside these callbacks.
		onRegister: async (keyCombination: KeyboardEventSupportedKey[]) => {
			if (shortcutValue) {
				const { error: unregisterError } =
					await tauri!.rpc.globalShortcuts.unregisterCommand({
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

			if (!tauri) return;
			const { data: accelerator, error: acceleratorError } =
				tauri.globalShortcuts.pressedKeysToTauriAccelerator(keyCombination);

			if (acceleratorError) {
				notify.error({
					title: 'Invalid shortcut combination',
					description: `The key combination "${keyCombination.join('+')}" is not valid. Please try a different combination.`,
					action: { type: 'more-details', error: acceleratorError },
				});
				return;
			}

			const { error: registerError } =
				await tauri!.rpc.globalShortcuts.registerCommand({
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
				await tauri!.rpc.globalShortcuts.unregisterCommand({
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
