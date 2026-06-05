<script lang="ts">
	import * as Select from '@epicenter/ui/select';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './types';

	// A Select rather than a checkbox: a checkbox cannot represent the empty state a
	// nullable boolean needs, and the Select reuses the same choice pattern as enum.
	// Real booleans are mapped to/from the Select's string values.
	let { cell, field, save }: FieldProps = $props();

	const CLEAR = ' '; // a sentinel no boolean string can collide with
	const selected = $derived(cell.value == null ? '' : String(cell.value));

	function onValueChange(value: string) {
		if (value === CLEAR) save(undefined);
		else save(value === 'true');
	}
</script>

<Select.Root type="single" value={selected} {onValueChange}>
	<Select.Trigger size="sm" class="w-full">
		{#if cell.value == null}
			<FieldEmpty state={cell.state} />
		{:else}
			{cell.value ? '✓ true' : '✗ false'}
		{/if}
	</Select.Trigger>
	<Select.Content>
		{#if field.derived.nullable}
			<Select.Item value={CLEAR} label="(clear)" />
		{/if}
		<Select.Item value="true" label="true" />
		<Select.Item value="false" label="false" />
	</Select.Content>
</Select.Root>
