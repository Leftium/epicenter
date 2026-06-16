<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import {
		RECORDING_TRIGGER_OPTIONS,
		type RecordingTrigger,
	} from '$lib/constants/audio';
	import { tauri } from '#platform/tauri';
	import { settings } from '$lib/state/settings.svelte';

	let { class: className }: { class?: string } = $props();

	const combobox = useCombobox();

	const availableTriggers = $derived(
		RECORDING_TRIGGER_OPTIONS.filter((trigger) => {
			if (!trigger.desktopOnly) return true;
			// Desktop only, only show if Tauri is available
			return !!tauri;
		}),
	);

	const currentTrigger = $derived(
		availableTriggers.find(
			(trigger) => trigger.value === settings.get('recording.trigger'),
		),
	);
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				class={cn('relative', className)}
				tooltip={currentTrigger
					? `Recording trigger: ${currentTrigger.label}`
					: 'Select recording trigger'}
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
					{#each availableTriggers as trigger (trigger.value)}
						{@const isSelected =
							settings.get('recording.trigger') === trigger.value}
						<Command.Item
							value={trigger.value}
							onSelect={async () => {
								settings.set(
									'recording.trigger',
									trigger.value as RecordingTrigger,
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
							<span class="text-base">{trigger.icon}</span>
							<span class="text-sm">{trigger.label}</span>
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
