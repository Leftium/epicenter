import type * as Y from 'yjs';
import {
	attachTable,
	type TableDefinitions,
	type Tables,
} from '../document/table.js';

/**
 * Benchmark-only ergonomic: attach every table in a definitions map to an
 * externally-constructed Y.Doc. Production callers go through
 * `createWorkspace`, which owns the Y.Doc and the encryption layer; the
 * benchmarks in `src/__benchmarks__` construct fresh Y.Docs themselves to
 * measure binary size, GC behavior, and reload cost, so they need a lower
 * primitive than `createWorkspace` exposes.
 */
export function createTables<T extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: T,
): Tables<T> {
	const entries = Object.entries(definitions).map(([name, def]) => [
		name,
		attachTable(ydoc, name, def),
	]);
	return Object.fromEntries(entries) as Tables<T>;
}
