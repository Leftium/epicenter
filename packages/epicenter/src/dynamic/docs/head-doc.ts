import * as Y from 'yjs';

import type { Icon } from '../../core/schema/fields/types.js';
import type {
	InferProviderExports,
	Lifecycle,
	ProviderFactoryMap,
} from './provider-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Meta Type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Workspace identity metadata stored in the Head Doc.
 *
 * This is separate from the definition/data (which lives in Workspace Docs)
 * because renaming a workspace should apply to all epochs immediately.
 */
export type WorkspaceMeta = {
	/** Display name of the workspace */
	name: string;
	/** Optional icon (tagged string format: 'emoji:📝', 'lucide:file', 'url:...') */
	icon: Icon | null;
	/** Optional description */
	description: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Head Doc
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a Head Y.Doc wrapper for managing workspace epoch state.
 *
 * Each workspace has one Head Y.Doc that syncs with all collaborators.
 * It stores the current epoch number, which determines which Workspace Y.Doc to use.
 *
 * Y.Doc ID: `{workspaceId}` (no epoch suffix)
 *
 * ## CRDT-Safe Epoch Pattern
 *
 * Epochs use a **per-client MAX pattern** to handle concurrent bumps safely.
 * This is similar to the per-client counter pattern from [learn.yjs.dev](https://learn.yjs.dev/lessons/02-counter/),
 * but uses `max()` instead of `sum()` for version semantics.
 *
 * ### Why not a simple counter?
 *
 * A naive implementation would store a single `epoch: number`:
 *
 * ```typescript
 * // BAD: Concurrent bumps cause lost updates
 * setEpoch(epoch: number) {
 *   headMap.set('epoch', epoch);  // Overwrites other clients!
 * }
 * ```
 *
 * If two clients both read epoch=2 and set epoch=3 simultaneously,
 * one bump is silently lost (higher clientID wins in YJS).
 *
 * ### The solution: Per-client keys with MAX aggregation
 *
 * Each client writes to their own key (clientID), then we compute `max()`:
 *
 * ```
 * Y.Map('epochs')
 *   └── "1090160253": 3   // Client A proposed epoch 3
 *   └── "2847291038": 3   // Client B also proposed epoch 3
 *   └── "9182736450": 5   // Client C proposed epoch 5
 *
 * getEpoch() → max(3, 3, 5) → 5
 * ```
 *
 * ### Why MAX instead of SUM?
 *
 * - **SUM** (counter pattern): "How many total bumps happened?" → Can skip epochs
 * - **MAX** (version pattern): "What's the highest version proposed?" → No gaps
 *
 * Two clients bumping concurrently both propose "next version" (e.g., 3).
 * With MAX, they converge to epoch 3. With SUM, you'd get epoch 4 (skipping 3).
 *
 * Structure:
 * ```
 * Y.Map('epochs')
 *   └── {clientId}: number  // Each client's proposed epoch
 * ```
 *
 * @example
 * ```typescript
 * const head = createHeadDoc({
 *   workspaceId: 'abc123xyz789012',
 *   providers: {
 *     persistence: ({ ydoc }) => tauriPersistence(ydoc, ['head']),
 *   },
 * });
 *
 * // Await sync before reading (persistence loads from disk)
 * await head.whenSynced;
 *
 * // Get current epoch (max of all client proposals)
 * const epoch = head.getEpoch(); // 0
 *
 * // Bump epoch safely (handles concurrent bumps)
 * const newEpoch = head.bumpEpoch(); // 1
 *
 * // Observe epoch changes (for reconnecting to new Workspace Doc)
 * const unsubscribe = head.observeEpoch((newEpoch) => {
 *   const workspaceDocId = `${head.workspaceId}-${newEpoch}`;
 *   // Reconnect to new Workspace Doc
 * });
 * ```
 *
 * @see https://learn.yjs.dev/lessons/02-counter/ - The counter pattern this is based on
 * @see .claude/skills/yjs/SKILL.md - Single-Writer Keys pattern documentation
 */
export function createHeadDoc<T extends ProviderFactoryMap>(options: {
	workspaceId: string;
	providers: T;
}) {
	const { workspaceId, providers: providerFactories } = options;
	const ydoc = new Y.Doc({ guid: workspaceId });
	const epochsMap = ydoc.getMap<number>('epochs');
	const metaMap = ydoc.getMap<string | Icon | null>('meta');

	// Initialize providers synchronously — async work is in their whenSynced
	const providers = {} as InferProviderExports<T>;
	for (const [id, factory] of Object.entries(providerFactories)) {
		(providers as Record<string, unknown>)[id] = factory({ ydoc });
	}

	// Aggregate all provider whenSynced promises
	const whenSynced = Promise.all(
		Object.values(providers).map((p) => (p as Lifecycle).whenSynced),
	).then(() => {});

	return {
		/** The underlying Y.Doc instance. */
		ydoc,

		/** The workspace ID (Y.Doc guid). */
		workspaceId,

		/** Provider exports. */
		providers,

		/** Resolves when all providers are synced. */
		whenSynced,

		/**
		 * Get the current epoch number.
		 *
		 * Computes the maximum of all client-proposed epochs.
		 * This ensures concurrent bumps converge to the same version
		 * without skipping epoch numbers.
		 *
		 * @returns The current epoch (0 if no bumps have occurred)
		 *
		 * @example
		 * ```typescript
		 * // Initial state
		 * head.getEpoch(); // 0
		 *
		 * // After some bumps
		 * head.bumpEpoch();
		 * head.getEpoch(); // 1
		 * ```
		 */
		getEpoch(): number {
			let max = 0;
			epochsMap.forEach((value) => {
				max = Math.max(max, value);
			});
			return max;
		},

		/**
		 * Get this client's own epoch value.
		 *
		 * This is the epoch value stored under THIS client's ID in the shared
		 * Y.Doc. It may be lower than `getEpoch()` if other clients have
		 * proposed higher epochs.
		 *
		 * Note: "Own" means "belonging to this client instance" (like JS's
		 * `hasOwnProperty`). The value IS synced in the shared doc; it's just
		 * scoped to this client's key.
		 *
		 * Useful for UI indicators showing "Your epoch: 2, Global: 3".
		 *
		 * @returns This client's epoch value (0 if never set)
		 *
		 * @example
		 * ```typescript
		 * // After another client bumps to 5
		 * head.getOwnEpoch(); // 0 (we haven't set ours)
		 * head.getEpoch();    // 5 (max across all clients)
		 *
		 * // After we bump
		 * head.bumpEpoch();
		 * head.getOwnEpoch(); // 6
		 * head.getEpoch();    // 6
		 * ```
		 */
		getOwnEpoch(): number {
			return epochsMap.get(ydoc.clientID.toString()) ?? 0;
		},

		/**
		 * Bump the epoch to the next version.
		 *
		 * This is the **safe** way to increment epochs. It:
		 * 1. Reads the current max epoch
		 * 2. Proposes `max + 1` under this client's ID
		 * 3. Returns the new epoch
		 *
		 * **Concurrent safety**: If two clients bump simultaneously, they both
		 * propose the same "next" value (e.g., both propose 3). After sync,
		 * `getEpoch()` returns 3, not 4. No epochs are skipped.
		 *
		 * @returns The new epoch number after bumping
		 *
		 * @example
		 * ```typescript
		 * const head = createHeadDoc({
		 *   workspaceId: 'abc123',
		 *   providers: { persistence: ({ ydoc }) => tauriPersistence(ydoc, ['head']) },
		 * });
		 *
		 * // Client A bumps
		 * const epoch1 = head.bumpEpoch(); // 1
		 *
		 * // Client B bumps concurrently (before sync)
		 * // Both propose epoch 1, converge to 1 after sync
		 *
		 * // Sequential bump after sync
		 * const epoch2 = head.bumpEpoch(); // 2
		 * ```
		 */
		bumpEpoch(): number {
			const next = this.getEpoch() + 1;
			epochsMap.set(ydoc.clientID.toString(), next);
			return next;
		},

		/**
		 * Set this client's own epoch to a specific value.
		 *
		 * Unlike `bumpEpoch()` which increments to create new epochs, this allows
		 * setting your own epoch to any value **up to** the current global epoch.
		 *
		 * **Safety constraint**: You cannot set higher than `getEpoch()`. If you try,
		 * the value is clamped to the current global epoch. This prevents accidental
		 * epoch inflation - only `bumpEpoch()` can create new epochs.
		 *
		 * Use cases:
		 * - UI "epoch selector" dropdown where user picks a historical epoch
		 * - Rollbacks to a previous epoch
		 * - Catching up to the current global epoch
		 *
		 * **After calling this**, recreate your workspace client:
		 *
		 * ```typescript
		 * const actualEpoch = head.setOwnEpoch(2);
		 * await oldWorkspace.destroy();
		 * const newWorkspace = createWorkspace({
		 *   headDoc: head,
		 *   definition: { name: 'Blog', tables: {...} },
		 * }).withExtensions({});
		 * ```
		 *
		 * @param epoch - The epoch number to set (clamped to current global epoch)
		 * @returns The actual epoch that was set (may be lower than requested if clamped)
		 *
		 * @example
		 * ```typescript
		 * // Global epoch is 3
		 *
		 * // User selects "Epoch 2" from dropdown - valid, sets to 2
		 * head.setOwnEpoch(2);  // Returns 2
		 *
		 * // User tries to set higher than global - clamped to 3
		 * head.setOwnEpoch(5);  // Returns 3 (clamped)
		 *
		 * // Recreate workspace at the actual epoch
		 * const epoch = head.setOwnEpoch(2);
		 * const workspace = createWorkspace({
		 *   headDoc: head,
		 *   definition: { name: 'Blog', tables: {...} },
		 * }).withExtensions({});
		 * ```
		 */
		setOwnEpoch(epoch: number): number {
			const globalEpoch = this.getEpoch();
			const clampedEpoch = Math.min(epoch, globalEpoch);
			epochsMap.set(ydoc.clientID.toString(), clampedEpoch);
			return clampedEpoch;
		},

		/**
		 * Get all client epoch proposals.
		 *
		 * Useful for:
		 * - Admin dashboards showing per-client sync state
		 * - Debugging sync issues ("Client A is on epoch 3, Client B is on epoch 2")
		 * - Understanding the epoch distribution across collaborators
		 *
		 * @returns Map of clientId to their proposed epoch
		 *
		 * @example
		 * ```typescript
		 * const proposals = head.getEpochProposals();
		 * // Map { "1090160253" => 3, "2847291038" => 3 }
		 *
		 * // Show in admin UI
		 * for (const [clientId, epoch] of proposals) {
		 *   console.log(`Client ${clientId} is on epoch ${epoch}`);
		 * }
		 * ```
		 */
		getEpochProposals(): Map<string, number> {
			return new Map(epochsMap.entries());
		},

		/**
		 * Observe epoch changes.
		 *
		 * Fires when any client proposes a new epoch, which may change the
		 * max epoch. Use this to reconnect to the new Workspace Y.Doc.
		 *
		 * The callback receives the new max epoch (computed via `getEpoch()`).
		 *
		 * @param callback - Function called with the new epoch when it changes
		 * @returns Unsubscribe function
		 *
		 * @example
		 * ```typescript
		 * const unsubscribe = head.observeEpoch((newEpoch) => {
		 *   console.log(`Epoch changed to ${newEpoch}`);
		 *   const workspaceDocId = `${head.workspaceId}-${newEpoch}`;
		 *   // Reconnect to new Workspace Doc...
		 * });
		 *
		 * // Later: stop observing
		 * unsubscribe();
		 * ```
		 */
		observeEpoch(callback: (epoch: number) => void) {
			let lastEpoch = this.getEpoch();

			const handler = () => {
				const currentEpoch = this.getEpoch();
				if (currentEpoch !== lastEpoch) {
					lastEpoch = currentEpoch;
					callback(currentEpoch);
				}
			};

			epochsMap.observeDeep(handler);
			return () => epochsMap.unobserveDeep(handler);
		},

		// ─────────────────────────────────────────────────────────────────────────
		// Meta (Workspace Identity)
		// ─────────────────────────────────────────────────────────────────────────

		/**
		 * Get the workspace metadata (name, icon, description).
		 *
		 * These values are shared across all epochs and collaborators.
		 * Renaming a workspace applies immediately to everyone.
		 *
		 * @returns The workspace meta object
		 *
		 * @example
		 * ```typescript
		 * const meta = head.getMeta();
		 * console.log(meta.name);        // "Whispering"
		 * console.log(meta.icon);        // 'emoji:🎙️'
		 * console.log(meta.description); // "Voice recordings"
		 * ```
		 */
		getMeta(): WorkspaceMeta {
			return {
				name: (metaMap.get('name') as string) ?? '',
				icon: (metaMap.get('icon') as Icon | null) ?? null,
				description: (metaMap.get('description') as string) ?? '',
			};
		},

		/**
		 * Set the workspace metadata.
		 *
		 * Only the provided fields are updated; others are left unchanged.
		 * Changes sync to all collaborators via CRDT.
		 *
		 * @param meta - Partial meta object with fields to update
		 *
		 * @example
		 * ```typescript
		 * // Update just the name
		 * head.setMeta({ name: 'My Workspace' });
		 *
		 * // Update multiple fields
		 * head.setMeta({
		 *   name: 'Whispering',
		 *   icon: 'emoji:🎙️',
		 *   description: 'Voice recordings and transcriptions',
		 * });
		 * ```
		 */
		setMeta(meta: Partial<WorkspaceMeta>): void {
			if (meta.name !== undefined) {
				metaMap.set('name', meta.name);
			}
			if (meta.icon !== undefined) {
				metaMap.set('icon', meta.icon);
			}
			if (meta.description !== undefined) {
				metaMap.set('description', meta.description);
			}
		},

		/**
		 * Observe workspace metadata changes.
		 *
		 * Fires when any meta field (name, icon, description) changes.
		 * The callback receives the full meta object.
		 *
		 * @param callback - Function called with the new meta when it changes
		 * @returns Unsubscribe function
		 *
		 * @example
		 * ```typescript
		 * const unsubscribe = head.observeMeta((meta) => {
		 *   console.log(`Workspace renamed to: ${meta.name}`);
		 *   // Update UI, document title, etc.
		 * });
		 *
		 * // Later: stop observing
		 * unsubscribe();
		 * ```
		 */
		observeMeta(callback: (meta: WorkspaceMeta) => void) {
			const handler = () => {
				callback(this.getMeta());
			};

			metaMap.observeDeep(handler);
			return () => metaMap.unobserveDeep(handler);
		},

		/**
		 * Check if workspace metadata has been initialized.
		 *
		 * Useful for migration: if meta is empty, you may need to
		 * copy name/icon/description from an older Workspace Doc.
		 *
		 * @returns true if meta has at least a name set
		 *
		 * @example
		 * ```typescript
		 * if (!head.hasMeta()) {
		 *   // Set initial identity for new workspace
		 *   head.setMeta({
		 *     name: 'My Workspace',
		 *     icon: null,
		 *     description: '',
		 *   });
		 * }
		 * ```
		 */
		hasMeta(): boolean {
			return metaMap.has('name') && (metaMap.get('name') as string) !== '';
		},

		/**
		 * Destroy providers and the underlying Y.Doc.
		 *
		 * Cleans up all provider resources before destroying the Y.Doc.
		 * Uses `allSettled` so one provider's destroy failure doesn't block others.
		 */
		async destroy() {
			await Promise.allSettled(
				Object.values(providers).map((p) => (p as Lifecycle).destroy()),
			);
			ydoc.destroy();
		},
	};
}

/** Head Y.Doc wrapper type - inferred from factory function. */
export type HeadDoc<T extends ProviderFactoryMap = ProviderFactoryMap> =
	ReturnType<typeof createHeadDoc<T>>;
