import { IndexeddbPersistence } from 'y-indexeddb';
import {
	defineExports,
	type ExtensionContext,
	type ExtensionFactory,
} from '../../core/extension';
import type { KvField, TableDefinition } from '../../core/schema';

/**
 * YJS document persistence extension using IndexedDB.
 * Stores the YDoc in the browser's IndexedDB storage.
 *
 * **Platform**: Web/Browser
 *
 * **How it works**:
 * 1. Creates an IndexedDB database named after the workspace ID
 * 2. Loads existing state from IndexedDB on startup (automatic via y-indexeddb)
 * 3. Auto-saves to IndexedDB on every YJS update (automatic via y-indexeddb)
 * 4. Uses the YDoc's guid as the database name (workspace ID)
 *
 * **Storage location**: Browser's IndexedDB (inspect via DevTools)
 * - Chrome: DevTools → Application → IndexedDB
 * - Firefox: DevTools → Storage → IndexedDB
 * - Each workspace gets its own database
 *
 * **Multi-workspace support**: Multiple workspaces create separate IndexedDB databases,
 * each named after its workspace ID.
 *
 * **Dependencies**: Requires `y-indexeddb` package
 * ```bash
 * bun add y-indexeddb yjs
 * ```
 *
 * @example Basic usage in a browser app
 * ```typescript
 * import { defineWorkspace, createClient } from '@epicenter/hq';
 * import { persistence } from '@epicenter/hq/extensions/persistence';
 *
 * const definition = defineWorkspace({
 *   tables: { ... },
 *   kv: {},
 * });
 *
 * // 'blog' becomes the IndexedDB database name
 * const client = createClient('blog', { epoch })
 *   .withDefinition(definition)
 *   .withExtensions({ persistence });
 * ```
 *
 * @example In a Svelte/React component
 * ```typescript
 * import { definition } from './workspace-config';
 * import { createClient } from '@epicenter/hq';
 *
 * // Inside component setup/onMount:
 * const client = createClient(definition.id, { epoch })
 *   .withDefinition(definition)
 *   .withExtensions({ persistence });
 *
 * // Data persists across page refreshes!
 * // Check DevTools → Application → IndexedDB to see the database
 * ```
 *
 * @example Multi-workspace setup
 * ```typescript
 * // Each workspace gets its own IndexedDB database
 * const blogDefinition = defineWorkspace({
 *   tables: { ... },
 *   kv: {},
 * });
 *
 * const notesDefinition = defineWorkspace({
 *   tables: { ... },
 *   kv: {},
 * });
 *
 * // 'blog' → IndexedDB database named 'blog'
 * const blogClient = createClient('blog', { epoch })
 *   .withDefinition(blogDefinition)
 *   .withExtensions({ persistence });
 *
 * // 'notes' → IndexedDB database named 'notes'
 * const notesClient = createClient('notes', { epoch })
 *   .withDefinition(notesDefinition)
 *   .withExtensions({ persistence });
 *
 * // Workspaces are isolated, each with separate IndexedDB storage
 * ```
 *
 * @example Inspecting IndexedDB in browser
 * ```
 * 1. Open DevTools (F12)
 * 2. Go to Application tab (Chrome) or Storage tab (Firefox)
 * 3. Expand IndexedDB in the sidebar
 * 4. You'll see databases named after your workspace IDs
 * 5. Click to inspect the stored YJS document
 * ```
 *
 * @see {@link persistence} from `@epicenter/hq/extensions/persistence/desktop` for Node.js/filesystem version
 */
export const persistence = (<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>({
	ydoc,
}: ExtensionContext<TTableDefinitions, TKvFields>) => {
	// y-indexeddb handles both loading and saving automatically
	// Uses the YDoc's guid as the IndexedDB database name
	const persistence = new IndexeddbPersistence(ydoc.guid, ydoc);

	console.log(`[Persistence] IndexedDB persistence enabled for ${ydoc.guid}`);

	// Return exports with whenSynced for the y-indexeddb pattern
	// This allows the workspace to know when data has been loaded from IndexedDB
	return defineExports({
		whenSynced: persistence.whenSynced.then(() => {
			console.log(`[Persistence] IndexedDB synced for ${ydoc.guid}`);
		}),
		destroy: () => persistence.destroy(),
	});
}) satisfies ExtensionFactory<readonly TableDefinition[], readonly KvField[]>;
