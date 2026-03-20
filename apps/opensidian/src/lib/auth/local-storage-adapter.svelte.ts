/**
 * localStorage-backed auth storage adapter for web apps.
 *
 * Wraps {@link createPersistedState} from `@epicenter/svelte` to implement
 * the {@link AuthStorageAdapter} interface. Provides synchronous reads,
 * async writes, cross-tab sync via `storage` events, and schema validation
 * on every read.
 *
 * @example
 * ```typescript
 * import { createLocalStorageAdapter } from './local-storage-adapter.svelte';
 * import { AuthUser } from './types';
 * import { type } from 'arktype';
 *
 * const tokenStorage = createLocalStorageAdapter({
 *   key: 'honeycrisp:authToken',
 *   schema: type('string').or('undefined'),
 *   fallback: undefined,
 * });
 * ```
 */

import { createPersistedState } from '@epicenter/svelte/createPersistedState';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AuthStorageAdapter } from './types';

/**
 * Create a localStorage-backed storage adapter for auth state.
 *
 * Uses `createPersistedState` under the hood—schema validation, cross-tab
 * sync, and error recovery are all handled automatically. The adapter
 * exposes the same interface regardless of whether it backs a token (string)
 * or a user object (AuthUser).
 */
export function createLocalStorageAdapter<
	TSchema extends StandardSchemaV1,
	T = StandardSchemaV1.InferOutput<TSchema>,
>({
	key,
	schema,
	fallback,
}: {
	key: string;
	schema: TSchema;
	fallback: T;
}): AuthStorageAdapter<T> {
	const state = createPersistedState({
		key,
		schema,
		onParseError: () => fallback,
	});

	return {
		get() {
			return state.value as T;
		},
		async set(value: T) {
			state.value = value as StandardSchemaV1.InferOutput<TSchema>;
		},
		whenReady: Promise.resolve(),
	};
}
