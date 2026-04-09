<script lang="ts">
	import { format } from 'date-fns';
	import {
		localTimezone,
		NLPDateInput,
		toDateTimeString,
	} from '@epicenter/ui/natural-language-date-input';
	import { TimezoneCombobox } from '@epicenter/ui/timezone-combobox';
	import * as Popover from '@epicenter/ui/popover';
	import type { DateTimeString } from '@epicenter/workspace';
	import type { Entry } from '$lib/workspace/definition';
	import { parseDateTime } from '$lib/utils/dates';

	let {
		entry,
		wordCount,
		onUpdateCreatedAt,
	}: {
		entry: Entry;
		wordCount: number;
		onUpdateCreatedAt?: (createdAt: DateTimeString) => void;
	} = $props();

	let isPopoverOpen = $state(false);
	let selectedTimezone = $state(localTimezone());

	$effect(() => {
		selectedTimezone = entry.createdAt.split('|')[1] ?? localTimezone();
	});

</script>

<div class="flex items-center justify-between border-t px-4 py-1.5 text-xs text-muted-foreground">
	<div class="flex items-center gap-3">
		<span>{wordCount} {wordCount === 1 ? 'word' : 'words'}</span>
		{#if entry.tags.length > 0}
			<span>{entry.tags.join(', ')}</span>
		{/if}
	</div>
	<div class="flex items-center gap-3">
		<Popover.Root bind:open={isPopoverOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						disabled={!onUpdateCreatedAt}
						class="cursor-pointer rounded-sm transition hover:underline disabled:cursor-default disabled:hover:no-underline"
					>
						Created {format(parseDateTime(entry.createdAt), 'MMM d, yyyy')}
					</button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content side="top" align="end" class="w-80 space-y-3 p-3">
				<NLPDateInput
					onChoice={({ date }) => {
						onUpdateCreatedAt?.(toDateTimeString(date, selectedTimezone));
						isPopoverOpen = false;
					}}
				/>
				<TimezoneCombobox bind:value={selectedTimezone} />
			</Popover.Content>
		</Popover.Root>
		<span>Updated {format(parseDateTime(entry.updatedAt), 'MMM d · h:mm a')}</span>
	</div>
</div>
