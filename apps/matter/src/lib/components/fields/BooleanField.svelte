<script lang="ts">
	import { Checkbox } from '@epicenter/ui/checkbox';
	import type { FieldProps } from './types';

	// A checkbox, not a Select: with everything-required a boolean is exactly true or
	// false, plus the "not filled in yet" state, and a checkbox shows all three
	// without a popover. checked = true, empty box = false, the minus (indeterminate)
	// = NEEDS_VALUE. Clicking an indeterminate box sets it true (bits-ui), which fills
	// the cell; the grid rings NEEDS_VALUE until then.
	//
	// The committed value is a real boolean primitive, never a string or 0/1: the
	// `{type:'boolean'}` schema validates only JS booleans, so anything else would
	// flip the cell to INVALID (and route to the repair editor). bits-ui hands
	// onCheckedChange a boolean, so the save is direct. No clear: every modeled field
	// is required, so "unset" is not a settable target, only an unfilled one.
	let { cell, field, save }: FieldProps = $props();

	const checked = $derived(cell.value === true);
	const indeterminate = $derived(cell.value == null);
</script>

<Checkbox
	{checked}
	{indeterminate}
	aria-label={field.name}
	onCheckedChange={(value) => save(value)}
/>
