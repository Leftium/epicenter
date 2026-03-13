import type { InferKvValue } from '@epicenter/workspace';
import { SvelteMap } from 'svelte/reactivity';
import workspace from '$lib/workspace';

const KV_DEFINITIONS = workspace.definitions.kv;

type KvDefs = typeof KV_DEFINITIONS;

function createWorkspaceSettings() {
	const map = new SvelteMap<string, unknown>();

	// Initialize SvelteMap with current values for ALL KV keys.
	// kv.get() always returns a valid value (stored value or defaultValue).
	for (const key of Object.keys(KV_DEFINITIONS)) {
		map.set(key, workspace.kv.get(key));
	}

	// Single observer for ALL KV changes (local or remote).
	// Observer updates SvelteMap → components re-render per-key.
	workspace.kv.observeAll((changes) => {
		for (const [key, change] of changes) {
			if (change.type === 'set') {
				map.set(key, change.value);
			} else if (change.type === 'delete') {
				// On delete, restore default value so map always has a value
				map.set(key, workspace.kv.get(key));
			}
		}
	});

	return {
		/**
		 * Get a synced workspace setting. Returns the current value from the
		 * reactive SvelteMap. Components reading this will re-render when the
		 * value changes (from local writes OR remote sync).
		 */
		get<K extends keyof KvDefs & string>(key: K): InferKvValue<KvDefs[K]> {
			return map.get(key) as InferKvValue<KvDefs[K]>;
		},

		/**
		 * Set a synced workspace setting. Writes to Yjs KV, which fires the
		 * observer, which updates the SvelteMap. Unidirectional — never set
		 * the SvelteMap directly.
		 */
		set<K extends keyof KvDefs & string>(
			key: K,
			value: InferKvValue<KvDefs[K]>,
		) {
			workspace.kv.set(key, value);
		},
	};
}

export const workspaceSettings = createWorkspaceSettings();
