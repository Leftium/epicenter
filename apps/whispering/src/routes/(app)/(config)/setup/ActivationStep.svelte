<!--
	Activation step: recording trigger + the shortcut(s) that start a recording.
	One shortcut system per platform (mirrors the rdev trigger backend): the
	desktop app binds system-wide global shortcuts, the browser binds in-app
	shortcuts. They never both show — the recorder swaps with the platform.
-->
<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import KeyboardIcon from '@lucide/svelte/icons/keyboard';
	import { commands, type Command } from '$lib/commands';
	import {
		RECORDING_TRIGGER_META,
		RECORDING_TRIGGER_OPTIONS,
		type RecordingTrigger,
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

	const selectedRecordingTrigger = $derived(settings.get('recording.trigger'));
	const recordingTriggerLabel = $derived(
		RECORDING_TRIGGER_OPTIONS.find(
			(option) => option.value === selectedRecordingTrigger,
		)?.label,
	);
	// The toggle that starts a recording depends on the selected trigger.
	const activeToggleCommand = $derived(
		commandById(RECORDING_TRIGGER_META[selectedRecordingTrigger].toggleCommandId),
	);
</script>

<div class="space-y-5">
	<Field.Field>
		<Field.Label for="setup-recording-trigger">Recording trigger</Field.Label>
		<Select.Root
			type="single"
			bind:value={() => settings.get('recording.trigger'),
				(selected) => {
					if (selected) {
						settings.set('recording.trigger', selected as RecordingTrigger);
					}
				}}
		>
			<Select.Trigger id="setup-recording-trigger" class="w-full">
				{recordingTriggerLabel ?? 'Select a recording trigger'}
			</Select.Trigger>
			<Select.Content>
				{#each RECORDING_TRIGGER_OPTIONS as option}
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
			stop it.
		</Field.Description>
	</Field.Field>

	<div class="space-y-3">
		<p class="text-sm text-muted-foreground">
			{#if tauri}
				These work system-wide, even when Whispering is not focused. The Fn key,
				modifier-only holds, and single keys all work.
			{:else}
				These work while the Whispering tab is focused.
			{/if}
		</p>
		{@render shortcutRow({
			title:
				selectedRecordingTrigger === 'vad'
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
