<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Command from '@epicenter/ui/command';
	import { useCombobox } from '@epicenter/ui/hooks';
	import * as Popover from '@epicenter/ui/popover';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';

	let {
		value,
		models,
		onSelect,
		class: className,
	}: {
		value: string;
		models: readonly string[];
		onSelect: (model: string) => void;
		class?: string;
	} = $props();

	const combobox = useCombobox();
	let searchValue = $state('');

	const filteredModels = $derived(
		searchValue
			? models.filter((m) =>
					m.toLowerCase().includes(searchValue.toLowerCase()),
				)
			: models,
	);

	/**
	 * Show the "Use as custom model" option when the user typed something
	 * that doesn't exactly match any known model.
	 */
	const showCustomOption = $derived(
		searchValue.trim() !== '' &&
			!models.some((m) => m.toLowerCase() === searchValue.trim().toLowerCase()),
	);

	function selectModel(model: string) {
		onSelect(model);
		searchValue = '';
		combobox.closeAndFocusTrigger();
	}
</script>

<Popover.Root bind:open={combobox.open}>
	<Popover.Trigger bind:ref={combobox.triggerRef}>
		{#snippet child({ props })}
			<Button
				{...props}
				class={cn('justify-between font-normal', className)}
				role="combobox"
				aria-expanded={combobox.open}
				variant="outline"
				size="sm"
			>
				<span class="truncate"
					>{value || 'Select model…'}</span
				>
				<ChevronsUpDownIcon class="ml-2 size-3 shrink-0 opacity-50" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-[280px] p-0" align="start">
		<Command.Root shouldFilter={false}>
			<Command.Input
				placeholder="Search or type a model…"
				class="h-9 text-sm"
				bind:value={searchValue}
			/>
			<Command.List class="max-h-[300px]">
				<Command.Empty>No models found.</Command.Empty>
				{#each filteredModels as model (model)}
					<Command.Item
						value={model}
						onSelect={() => selectModel(model)}
						class="text-xs"
					>
						<CheckIcon
							class={cn('mr-1.5 size-3 shrink-0', {
								'text-transparent': value !== model,
							})}
						/>
						{model}
					</Command.Item>
				{/each}
				{#if showCustomOption}
					<Command.Separator />
					<Command.Item
						value={'custom:' + searchValue.trim()}
						onSelect={() => selectModel(searchValue.trim())}
						class="text-xs"
					>
						Use "{searchValue.trim()}"
					</Command.Item>
				{/if}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>
