<script lang="ts">
	import type { CellResult } from '$lib/model/conformance';
	import type { DerivedKind, Kind } from '$lib/model/schema';
	import ConformanceCell from './ConformanceCell.svelte';

	let {
		cell,
		derivedKind,
		name,
		onSave,
	}: {
		cell: CellResult;
		derivedKind: DerivedKind;
		name: string;
		/** `value === undefined` clears the field (removes the key, never null). */
		onSave: (name: string, key: string, value: unknown) => void;
	} = $props();

	// Kinds a single text input can faithfully edit. Arrays and the json fallback
	// keep their read-only render until the typed chip/widget editors land (inc 3).
	const INLINE: ReadonlySet<Kind> = new Set([
		'string',
		'integer',
		'number',
		'boolean',
		'url',
		'datetime',
		'enum',
	]);
	const editable = $derived(INLINE.has(derivedKind.kind));

	// Local draft: an in-progress edit lives HERE, not in the store, so an echo
	// delta re-rendering the cell never stomps what you are typing. Seeded only
	// when you enter edit mode.
	let editing = $state(false);
	let draft = $state('');

	function start() {
		if (!editable) return;
		draft = cell.value == null ? '' : String(cell.value);
		editing = true;
	}

	/**
	 * Coerce the typed text to the field's kind so its YAML type matches the
	 * model. A value that will not coerce (e.g. "abc" for a number) is written as
	 * the raw string, so it persists as an INVALID cell you can keep fixing rather
	 * than being silently dropped. Empty clears the field.
	 */
	function coerce(value: string): unknown {
		if (value.trim() === '') return undefined;
		switch (derivedKind.kind) {
			case 'boolean':
				return value === 'true' ? true : value === 'false' ? false : value;
			case 'integer':
			case 'number': {
				const n = Number(value);
				return Number.isFinite(n) ? n : value;
			}
			default:
				return value;
		}
	}

	function commit() {
		editing = false;
		const next = coerce(draft);
		// No-op guard: do not write (and trigger an echo) when nothing changed.
		const unchanged =
			next === undefined ? cell.value == null : next === cell.value;
		if (unchanged) return;
		onSave(name, cell.name, next);
	}

	const autofocus = (node: HTMLInputElement) => node.select();
</script>

{#if editing}
	<input
		use:autofocus
		bind:value={draft}
		onblur={commit}
		onkeydown={(e) => {
			if (e.key === 'Enter') commit();
			else if (e.key === 'Escape') editing = false;
		}}
		class="w-full rounded border bg-background px-1 py-0.5 text-sm"
	/>
{:else}
	<button
		type="button"
		onclick={start}
		class="block w-full cursor-text text-left {editable ? '' : 'cursor-default'}"
	>
		<ConformanceCell {cell} {derivedKind} />
	</button>
{/if}
