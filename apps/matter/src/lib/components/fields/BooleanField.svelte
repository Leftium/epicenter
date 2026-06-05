<script lang="ts">
	import * as Select from '@epicenter/ui/select';
	import FieldEmpty from './FieldEmpty.svelte';
	import type { FieldProps } from './types';

	// A Select rather than a checkbox: a checkbox cannot show the empty NEEDS_VALUE
	// state a required-but-absent boolean has (checked / unchecked cannot also mean
	// "unset"). The Select shows the empty placeholder when the value is absent, and
	// reuses the same choice pattern as select. Real booleans map to/from the string
	// values. There is no "(clear)" option: every modeled field is required.
	let { cell, save }: FieldProps = $props();

	const selected = $derived(cell.value == null ? '' : String(cell.value));
</script>

<Select.Root
	type="single"
	value={selected}
	onValueChange={(value) => save(value === 'true')}
>
	<Select.Trigger size="sm" class="w-full">
		{#if cell.value == null}
			<FieldEmpty />
		{:else}
			{cell.value ? '✓ true' : '✗ false'}
		{/if}
	</Select.Trigger>
	<Select.Content>
		<Select.Item value="true" label="true" />
		<Select.Item value="false" label="false" />
	</Select.Content>
</Select.Root>
