<script lang="ts">
	import type { Cell } from '$lib/model/conformance';
	import { FIELD_COMPONENTS } from './fields/registry';
	import type { ClearField, SaveField } from './fields/types';
	import JsonRepairEditor from './JsonRepairEditor.svelte';

	let {
		cell,
		save,
		clear,
	}: {
		cell: Cell;
		save: SaveField;
		clear: ClearField;
	} = $props();

	// Kind dispatch is gated behind VALIDITY: an INVALID value is out of every
	// widget's domain, so it goes to the universal JSON repair editor; an OK or
	// empty value goes to the typed field widget for its kind. The widget never sees
	// an INVALID value, which is why no widget handles that state.
	const FieldComponent = $derived(FIELD_COMPONENTS[cell.field.kind]);
</script>

{#if cell.state === 'INVALID'}
	<JsonRepairEditor {cell} {save} {clear} />
{:else}
	<FieldComponent {cell} {save} {clear} />
{/if}
