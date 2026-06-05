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

	// Kind dispatch is gated behind VALIDITY. An INVALID value is out of its
	// widget's domain, so it gets the universal REPAIR editor: edit the JSON-
	// serialized value and re-parse on commit. JSON (not the bare scalar) because
	// at the type boundary explicit identity is the whole point ("1240s" reads as
	// a string, not a number), and it round-trips any shape (array, object) the
	// kind-directed scalar editor below cannot author. The moment the saved value
	// validates, the cell reclassifies to OK through the watcher and the in-domain
	// editor (or, later, the typed widget) takes back over.
	const isInvalid = $derived(cell.state === 'INVALID');

	// Scalar kinds the in-domain text editor can faithfully edit. A VALID value of
	// another kind (array, json) has no inline editor yet (typed widgets land in
	// 3.5); an INVALID value of ANY kind is always repairable via the JSON path.
	const INLINE: ReadonlySet<Kind> = new Set([
		'string',
		'integer',
		'number',
		'boolean',
		'url',
		'datetime',
		'enum',
	]);
	const editable = $derived(isInvalid || INLINE.has(derivedKind.kind));

	// The one justified island of local state. Everything else in the app is
	// one-directional derived from the file; an OPEN cell is the exception, because
	// an editing session inherently holds a keystroke buffer that is not yet "the
	// new value" and is not on disk. It detaches from the projection while open
	// (seeded once on enter-edit), so an echo delta re-rendering the cell cannot
	// stomp what you are typing; committing on change writes it back down.
	let editing = $state(false);
	let draft = $state('');
	// Set when a repair draft is not valid JSON: the edit is held (not written, not
	// discarded) so you can fix the syntax. Cleared on the next keystroke.
	let parseError = $state<string | undefined>(undefined);

	function start() {
		if (!editable) return;
		// Repair seeds the explicit JSON form; in-domain seeds the bare scalar.
		draft = isInvalid
			? (JSON.stringify(cell.value) ?? '')
			: cell.value == null
				? ''
				: String(cell.value);
		parseError = undefined;
		editing = true;
	}

	/**
	 * Coerce in-domain text to the field's kind so its YAML type matches the model.
	 * A value that will not coerce (e.g. "abc" for a number) is kept as the raw
	 * string, so it persists as an INVALID cell you can keep fixing rather than
	 * being silently dropped.
	 */
	function coerce(value: string): unknown {
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

	/**
	 * Turn the draft into the value to save. Empty clears the field in BOTH modes
	 * (delete the key, never write `null`/`""`). A repair draft must parse as JSON;
	 * a syntax error returns `{ error }` so the edit is surfaced and held, never
	 * written as broken text. An in-domain draft is coerced to the field's kind.
	 * Parsing (not validation) is the only gate on saving: an invalid-against-the-
	 * model value still saves and stays INVALID, since the model never gates a write.
	 */
	function parseDraft(): { value: unknown } | { error: string } {
		if (draft.trim() === '') return { value: undefined };
		if (isInvalid) {
			try {
				return { value: JSON.parse(draft) };
			} catch {
				return { error: 'Not valid JSON' };
			}
		}
		return { value: coerce(draft) };
	}

	function commit() {
		const result = parseDraft();
		if ('error' in result) {
			parseError = result.error; // hold the edit open so you can fix the syntax
			return;
		}
		editing = false;
		const next = result.value;
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
		oninput={() => (parseError = undefined)}
		onblur={commit}
		onkeydown={(e) => {
			if (e.key === 'Enter') commit();
			else if (e.key === 'Escape') {
				editing = false;
				parseError = undefined;
			}
		}}
		class="w-full rounded border bg-background px-1 py-0.5 text-sm {parseError
			? 'border-destructive'
			: ''}"
	/>
	{#if parseError}
		<span class="mt-0.5 block text-xs text-destructive">{parseError}</span>
	{/if}
{:else}
	<button
		type="button"
		onclick={start}
		class="block w-full cursor-text text-left {editable ? '' : 'cursor-default'}"
	>
		<ConformanceCell {cell} {derivedKind} />
	</button>
{/if}
