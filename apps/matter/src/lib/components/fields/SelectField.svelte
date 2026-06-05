<script lang="ts">
	import * as Select from '@epicenter/ui/select';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './types';

	let { cell, field, save, clear }: FieldProps = $props();

	// The raw enum literals, NOT stringified: a numeric or boolean enum must save
	// its ORIGINAL typed value. Saving "2" for a `{ enum: [1, 2, 3] }` field would
	// fail the schema and flip the cell to INVALID, so options are keyed by INDEX
	// and mapped back to the literal on change. Indexing also sidesteps a [1, "1"]
	// key collision that stringified values would produce.
	const values = $derived(field.schema.enum ?? []);

	// The Select's value is the option index ('' = no selection). CLEAR is a
	// non-numeric token, so it can never collide with an index.
	const CLEAR = 'clear';
	const selected = $derived.by(() => {
		const i = values.findIndex((value) => Object.is(value, cell.value));
		return i >= 0 ? String(i) : '';
	});

</script>

<Select.Root
	type="single"
	value={selected}
	onValueChange={(value) =>
		value === CLEAR ? clear() : save(values[Number(value)])}
>
	<Select.Trigger size="sm" class="w-full">
		{#if cell.value == null}
			<FieldEmpty state={cell.state} />
		{:else}
			{String(cell.value)}
		{/if}
	</Select.Trigger>
	<Select.Content>
		{#if field.derived.nullable}
			<Select.Item value={CLEAR} label="(clear)" />
		{/if}
		{#each values as option, i (i)}
			<Select.Item value={String(i)} label={String(option)} />
		{/each}
	</Select.Content>
</Select.Root>
