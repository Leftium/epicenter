<script lang="ts">
	import type { Command } from '$lib/commands';
	import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
	import { report } from '$lib/report';
	import { localShortcuts } from '$lib/operations/shortcuts';
	import {
		arrayToShortcutString,
		type CommandId,
	} from '$lib/services/local-shortcut-manager';
	import { settings } from '$lib/state/settings.svelte';
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

	const shortcutValue = $derived(settings.get(`shortcut.${command.id}`));

	const keyRecorder = createKeyRecorder({
		pressedKeys,
		onRegister: async (keyCombination: KeyboardEventSupportedKey[]) => {
			const { error: unregisterError } =
				await localShortcuts.unregisterCommand({
					commandId: command.id as CommandId,
			});
			if (unregisterError) {
				report.error({
					title: 'Error unregistering local shortcut',
					cause: unregisterError,
				});
			}
			const { error: registerError } = await localShortcuts.registerCommand(
				{
					command,
					keyCombination,
				},
			);

			if (registerError) {
				report.error({
					title: 'Error registering local shortcut',
					cause: registerError,
				});
				return;
			}

			settings.set(
				`shortcut.${command.id}`,
				arrayToShortcutString(keyCombination),
			);

			report.success({
				title: `Local shortcut set to ${keyCombination}`,
				description: `Press the shortcut to trigger "${command.title}"`,
			});
		},
		onClear: async () => {
			const { error: unregisterError } =
				await localShortcuts.unregisterCommand({
					commandId: command.id as CommandId,
			});
			if (unregisterError) {
				report.error({
					title: 'Error clearing local shortcut',
					cause: unregisterError,
				});
			}
			settings.set(`shortcut.${command.id}`, null);

			report.success({
				title: 'Local shortcut cleared',
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
