<script lang="ts">
	import TextCell from './TextCell.svelte';
	import type { FieldProps } from './types';

	// The widget floor: a plain text input over the raw string. Empty clears the
	// field (delete the key); any non-empty text saves verbatim. `string` is the
	// always-valid base kind, so the draft never fails to parse.
	let { cell, save, clear }: FieldProps = $props();
</script>

<TextCell
	{cell}
	{save}
	{clear}
	parse={(text) =>
		text.trim() === '' ? { type: 'clear' } : { type: 'value', value: text }}
/>
