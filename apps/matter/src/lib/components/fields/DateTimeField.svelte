<script lang="ts">
	import TextCell from './TextCell.svelte';
	import type { FieldProps } from './types';

	// A text input over the RFC 3339 string for now; a NaturalLanguageDateInput
	// picker lands with the calendar view (spec "Later"). A value that is not valid
	// RFC 3339 classifies INVALID and routes to the JSON repair editor, so this only
	// ever sees a parseable instant. Same verbatim-text parse as `string`; the
	// distinct kind is the seam where the picker replaces this one prop.
	let { cell, save, clear }: FieldProps = $props();
</script>

<TextCell
	{cell}
	{save}
	{clear}
	displayClass="tabular-nums"
	parse={(text) =>
		text.trim() === '' ? { type: 'clear' } : { type: 'value', value: text }}
/>
