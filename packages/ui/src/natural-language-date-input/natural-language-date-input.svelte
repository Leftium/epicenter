<script lang="ts">
	import type { DateTimeString } from '@epicenter/workspace';
	import { Button } from '#/button';
	import { Input } from '#/input';
	import {
		localTimezone,
		parseNaturalLanguageDate,
		toDateTimeString,
	} from './parse-date.js';
	import TimezoneCombobox from './timezone-combobox.svelte';

	let {
		value = $bindable(),
		placeholder = 'Type a date...',
		disabled = false,
		onconfirm,
	}: {
		value: DateTimeString | undefined;
		placeholder?: string;
		disabled?: boolean;
		onconfirm?: (value: DateTimeString) => void;
	} = $props();

	let inputText = $state('');
	let selectedTimezone = $state(value?.split('|')[1] || localTimezone());
	const timezone = $derived(value?.split('|')[1] || localTimezone());

	$effect(() => {
		if (!inputText && selectedTimezone !== timezone) {
			selectedTimezone = timezone;
		}
	});

	const parsed = $derived(
		inputText ? parseNaturalLanguageDate(inputText, selectedTimezone) : null,
	);
	const preview = $derived(
		parsed ? formatPreview(parsed.utcDate, parsed.timezone) : null,
	);

	function formatPreview(date: Date, timezone: string): string {
		const formattedDate = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			weekday: 'long',
			month: 'short',
			day: 'numeric',
			year: 'numeric',
		}).format(date);

		const formattedTime = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			hour: 'numeric',
			minute: '2-digit',
			timeZoneName: 'short',
		}).format(date);

		return `${formattedDate} · ${formattedTime}`;
	}
</script>

<div class="flex flex-col gap-3">
	<Input bind:value={inputText} {placeholder} {disabled} />

	<TimezoneCombobox bind:value={selectedTimezone} {disabled} />

	{#if parsed && preview}
		<div class="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
			<span class="min-w-0 flex-1 text-sm text-muted-foreground">{preview}</span>
			<Button
				size="sm"
				{disabled}
				onclick={() => {
					const result = toDateTimeString(parsed.utcDate, parsed.timezone);
					value = result;
					onconfirm?.(result);
					inputText = '';
				}}
			>
				Confirm
			</Button>
		</div>
	{/if}
</div>
