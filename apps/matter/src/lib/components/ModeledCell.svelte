<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import type { Cell } from '$lib/core/conformance';
	import { FIELD_COMPONENTS } from './fields/registry';
	import type { SaveField } from './fields/field-props';
	import JsonRepairEditor from './JsonRepairEditor.svelte';

	let {
		cell,
		save,
		clear,
	}: {
		cell: Cell;
		save: SaveField;
		/** Delete the field's key (back to NEEDS_VALUE), never write `null`. */
		clear: () => void;
	} = $props();

	// Kind dispatch is gated behind VALIDITY: an INVALID value is out of every
	// widget's domain, so it goes to the universal JSON repair editor; an OK or
	// empty value goes to the typed field widget for its kind. The widget never sees
	// an INVALID value, which is why no widget handles that state.
	const FieldComponent = $derived(FIELD_COMPONENTS[cell.field.kind]);

	// One clear control for every kind, owned here instead of reinvented per widget
	// (a blank text input, a Select item, removing the last chip, nothing at all).
	// It deletes the field's key, so it only makes sense when a value exists: shown
	// for OK and INVALID, never for an already-empty NEEDS_VALUE cell. The widgets
	// now only ever COMMIT a value in their kind's domain; clearing lives here.
	const clearable = $derived(cell.state !== 'NEEDS_VALUE');
</script>

<div class="group/cell flex items-center gap-1">
	<div class="min-w-0 flex-1">
		{#if cell.state === 'INVALID'}
			<JsonRepairEditor {cell} {save} />
		{:else}
			<FieldComponent {cell} {save} />
		{/if}
	</div>
	{#if clearable}
		<!-- Hover/focus reveal so a dense grid stays quiet, then the same control
		     surfaces on hover or keyboard focus in the grid and the detail dialog. -->
		<button
			type="button"
			onclick={clear}
			title="Clear"
			aria-label="Clear {cell.field.name}"
			class="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/cell:opacity-100 group-focus-within/cell:opacity-100"
		>
			<XIcon class="size-3.5" />
		</button>
	{/if}
</div>
