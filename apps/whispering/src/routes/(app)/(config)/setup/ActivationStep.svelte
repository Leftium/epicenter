<!--
	Activation step: recording mode + the shortcut(s) that start a recording.
	One shortcut system per platform (mirrors the rdev trigger backend): the
	desktop app binds system-wide global shortcuts, the browser binds in-app
	shortcuts. They never both show — the recorder swaps with the platform.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import KeyboardIcon from '@lucide/svelte/icons/keyboard';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import { commands, type Command } from '$lib/commands';
	import {
		RECORDING_MODE_OPTIONS,
		type RecordingMode,
		toggleCommandIdForMode,
	} from '$lib/constants/audio';
	import { report } from '$lib/report';
	import { settings } from '$lib/state/settings.svelte';
	import { createPressedKeys } from '$lib/utils/createPressedKeys.svelte';
	import { tauri } from '#platform/tauri';
	import GlobalKeyboardShortcutRecorder from '../settings/shortcuts/keyboard-shortcut-recorder/GlobalKeyboardShortcutRecorder.svelte';
	import LocalKeyboardShortcutRecorder from '../settings/shortcuts/keyboard-shortcut-recorder/LocalKeyboardShortcutRecorder.svelte';

	// Only the browser (local) recorder needs the shared pressed-keys tracker;
	// the desktop recorder captures through the rdev backend itself.
	const pressedKeys = createPressedKeys({
		onUnsupportedKey: (key) => {
			report.info({
				title: 'Unsupported key',
				description: `The key "${key}" is not supported. Try a different key.`,
			});
		},
	});

	function commandById(id: Command['id']) {
		const command = commands.find((item) => item.id === id);
		if (!command) throw new Error(`Missing command: ${id}`);
		return command;
	}

	const pushToTalkCommand = commandById('pushToTalk');

	const selectedRecordingMode = $derived(settings.get('recording.mode'));
	const recordingModeLabel = $derived(
		RECORDING_MODE_OPTIONS.find(
			(option) => option.value === selectedRecordingMode,
		)?.label,
	);
	// The toggle that starts a recording depends on the selected mode.
	const activeToggleCommand = $derived(
		commandById(toggleCommandIdForMode(selectedRecordingMode)),
	);
</script>

<div class="space-y-5">
	<Field.Field>
		<Field.Label for="setup-recording-mode">Recording mode</Field.Label>
		<Select.Root
			type="single"
			bind:value={() => settings.get('recording.mode'),
				(selected) => {
					if (selected) {
						settings.set('recording.mode', selected as RecordingMode);
					}
				}}
		>
			<Select.Trigger id="setup-recording-mode" class="w-full">
				{recordingModeLabel ?? 'Select a recording mode'}
			</Select.Trigger>
			<Select.Content>
				{#each RECORDING_MODE_OPTIONS as option}
					<Select.Item value={option.value} label={option.label}>
						<div class="flex items-center gap-2">
							<span>{option.icon}</span>
							<span>{option.label}</span>
						</div>
					</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		<Field.Description>
			Manual is best for deliberate dictation. Voice Activated listens until you
			stop it. Upload mode skips live recording.
		</Field.Description>
	</Field.Field>

	{#if selectedRecordingMode === 'upload'}
		<Alert.Root>
			<UploadIcon class="size-4" />
			<Alert.Title>Upload mode needs no shortcut</Alert.Title>
			<Alert.Description>
				You drop in an audio file instead of recording live. Switch to Manual or
				Voice Activated if you want a keyboard shortcut to start recording.
			</Alert.Description>
		</Alert.Root>
	{:else}
		<div class="space-y-3">
			<p class="text-sm text-muted-foreground">
				{#if tauri}
					These work system-wide, even when Whispering is not focused. The Fn
					key, modifier-only holds, and single keys all work.
				{:else}
					These work while the Whispering tab is focused.
				{/if}
			</p>
			{@render shortcutRow({
				title:
					selectedRecordingMode === 'vad'
						? 'Toggle voice activation'
						: 'Toggle recording',
				description: 'Press once to start, again to stop.',
				command: activeToggleCommand,
			})}
			{@render shortcutRow({
				title: 'Push to talk',
				description: 'Hold to record, release to transcribe.',
				command: pushToTalkCommand,
			})}
		</div>
	{/if}
</div>

{#snippet shortcutRow({
	title,
	description,
	command,
}: {
	title: string;
	description: string;
	command: Command;
})}
	<div
		class="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
	>
		<div class="flex min-w-0 items-start gap-3">
			<KeyboardIcon class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			<div class="min-w-0">
				<p class="text-sm font-medium">{title}</p>
				<p class="text-sm text-muted-foreground">{description}</p>
			</div>
		</div>
		<div class="shrink-0">
			{#if tauri}
				<GlobalKeyboardShortcutRecorder {command} {tauri} />
			{:else}
				<LocalKeyboardShortcutRecorder {command} {pressedKeys} />
			{/if}
		</div>
	</div>
{/snippet}
