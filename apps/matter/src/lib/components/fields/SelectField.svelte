<script lang="ts">
	import * as Select from '@epicenter/ui/select';
	import type { FieldOf } from '$lib/model/model';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './types';

	let { cell, save }: FieldProps<FieldOf<'select'>> = $props();

	// The raw enum literals, NOT stringified: a numeric or boolean enum must save
	// its ORIGINAL typed value. Saving "2" for a `{ enum: [1, 2, 3] }` field would
	// fail the schema and flip the cell to INVALID, so options are keyed by INDEX
	// and mapped back to the literal on change. Indexing also sidesteps a [1, "1"]
	// key collision that stringified values would produce. `cell.field` is the select
	// variant, so `schema.enum` is the typed primitives, never a raw `unknown[]`.
	const values = $derived(cell.field.schema.enum);

	// The Select's value is the option index ('' = no selection). Every modeled
	// field is required, so there is no "(clear)" option: you change a selection by
	// picking another value, never by emptying it.
	const selected = $derived.by(() => {
		if (cell.state !== 'OK') return '';
		const i = values.findIndex((value) => Object.is(value, cell.value));
		return i >= 0 ? String(i) : '';
	});
</script>

<Select.Root
	type="single"
	value={selected}
	onValueChange={(value) => save(values[Number(value)])}
>
	<Select.Trigger size="sm" class="w-full">
		{#if cell.state === 'NEEDS_VALUE'}
			<FieldEmpty />
		{:else}
			{String(cell.value)}
		{/if}
	</Select.Trigger>
	<Select.Content>
		{#each values as option, i (i)}
			<Select.Item value={String(i)} label={String(option)} />
		{/each}
	</Select.Content>
</Select.Root>
