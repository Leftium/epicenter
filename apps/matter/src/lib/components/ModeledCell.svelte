<script lang="ts">
	import type { CellResult } from '$lib/model/conformance';
	import type { ModelField } from '$lib/model/model';
	import { FIELD_COMPONENTS } from './fields/registry';
	import type { ClearField, SaveField } from './fields/types';
	import JsonRepairEditor from './JsonRepairEditor.svelte';

	let {
		cell,
		field,
		save,
		clear,
	}: {
		cell: CellResult;
		field: ModelField;
		save: SaveField;
		clear: ClearField;
	} = $props();

	// Kind dispatch is gated behind VALIDITY: an INVALID value is out of every
	// widget's domain, so it goes to the universal JSON repair editor; an OK or
	// empty value goes to the typed Field for its kind. The Field never sees an
	// INVALID value, which is why no Field handles that state.
	const Field = $derived(FIELD_COMPONENTS[field.derived.kind]);
</script>

{#if cell.state === 'INVALID'}
	<JsonRepairEditor {cell} {save} {clear} />
{:else}
	<Field {cell} {field} {save} {clear} />
{/if}
