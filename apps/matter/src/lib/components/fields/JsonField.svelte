<script lang="ts">
	import type { FieldProps } from './types';

	// Unreachable in practice: model.ts rejects any field whose kind derives to
	// `json` (the "unsupported shape" gate), so a json cell never reaches the grid.
	// This exists only to satisfy the exhaustive Record<Kind, FieldComponent> and
	// renders read-only rather than pretending to edit an unsupported shape. Do not
	// "fix" this path; the gate upstream is what keeps it unreachable.
	let { cell }: FieldProps = $props();
</script>

<code class="text-xs text-muted-foreground">{JSON.stringify(cell.value)}</code>
