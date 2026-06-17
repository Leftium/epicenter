<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import {
		RECORDING_MODE_ICONS,
		RECORDING_MODE_OPTIONS,
		type RecordingMode,
	} from '$lib/constants/audio';
	import { settings } from '$lib/state/settings.svelte';

	let { class: className }: { class?: string } = $props();

	const combobox = useCombobox();

	const currentMode = $derived(
		RECORDING_MODE_OPTIONS.find(
			(mode) => mode.value === settings.get('recording.mode'),
		),
	);
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				class={cn('relative', className)}
				tooltip={currentMode
					? `Recording mode: ${currentMode.label}`
					: 'Select recording mode'}
				role="combobox"
				aria-expanded={combobox.open}
				variant="ghost"
				size="icon"
			>
				<ChevronDown class="size-4" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="p-0 w-48">
		<Command.Root loop>
			<Command.List>
				<Command.Group>
					{#each RECORDING_MODE_OPTIONS as mode (mode.value)}
						{@const isSelected =
							settings.get('recording.mode') === mode.value}
						{@const ModeIcon = RECORDING_MODE_ICONS[mode.value]}
						<Command.Item
							value={mode.value}
							onSelect={async () => {
								settings.set(
									'recording.mode',
									mode.value as RecordingMode,
								);
								combobox.closeAndFocusTrigger();
							}}
							class="flex items-center gap-2 px-2 py-2"
						>
							<CheckIcon
								class={cn('size-3.5 shrink-0', {
									'text-transparent': !isSelected,
								})}
							/>
							<ModeIcon class="size-4 shrink-0" />
							<span class="text-sm">{mode.label}</span>
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
