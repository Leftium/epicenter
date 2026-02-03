import type { LayoutLoad } from './$types';
import { getStaticWorkspace } from '$lib/services/static-workspaces';
import {
	createYSweetConnection,
	getDefaultSyncUrl,
} from '$lib/docs/y-sweet-connection';
import { discoverKvKeys, discoverTables } from '$lib/docs/discover';

/**
 * Load a static workspace by ID.
 *
 * Flow:
 * 1. Look up registry entry (may not exist for ad-hoc viewing)
 * 2. Create Y-Sweet connection
 * 3. Wait for initial sync
 * 4. Discover tables and KV keys
 */
export const load: LayoutLoad = async ({ params }) => {
	const workspaceId = params.id;
	console.log(`[StaticLayout] Loading static workspace: ${workspaceId}`);

	// Get registry entry (may not exist for ad-hoc viewing)
	const entry = await getStaticWorkspace(workspaceId);

	// Determine sync URL
	const syncUrl = entry?.syncUrl ?? getDefaultSyncUrl();

	console.log(`[StaticLayout] Connecting to Y-Sweet at: ${syncUrl}`);

	// Create Y-Sweet connection
	const connection = createYSweetConnection({
		workspaceId,
		serverUrl: syncUrl,
	});

	console.log(`[StaticLayout] Provider created, waiting for sync...`);

	// Wait for initial sync with timeout
	let syncStatus = 'unknown';
	try {
		await Promise.race([
			connection.whenSynced,
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Sync timeout')), 10000),
			),
		]);
		syncStatus = 'synced';
		console.log(`[StaticLayout] Sync complete!`);
	} catch (e) {
		syncStatus = 'failed';
		console.error(`[StaticLayout] Failed to sync: ${e}`);
		// Don't throw - allow viewing even if sync fails
	}

	// Debug: Log raw Y.Doc state
	console.log(`[StaticLayout] Y.Doc guid: ${connection.ydoc.guid}`);
	console.log(
		`[StaticLayout] Y.Doc share keys:`,
		[...connection.ydoc.share.keys()],
	);

	// Debug: Log type information for each share key
	// Force instantiation using getArray() to see actual data
	for (const key of connection.ydoc.share.keys()) {
		if (key.startsWith('table:')) {
			const array = connection.ydoc.getArray(key);
			console.log(`[StaticLayout] Share key '${key}' (via getArray):`, {
				constructor: array?.constructor?.name,
				length: array.length,
				firstTwo: array.toArray().slice(0, 2),
			});
		}
	}

	// Discover structure
	const tables = discoverTables(connection.ydoc);
	const kvKeys = discoverKvKeys(connection.ydoc);

	console.log(
		`[StaticLayout] Discovered ${tables.length} tables, ${kvKeys.length} KV keys`,
	);
	console.log(`[StaticLayout] Tables:`, tables);
	console.log(`[StaticLayout] KV Keys:`, kvKeys);
	console.log(`[StaticLayout] Sync status: ${syncStatus}`);

	return {
		workspaceId,
		entry, // May be null for ad-hoc viewing
		connection,
		tables,
		kvKeys,
		displayName: entry?.name ?? workspaceId,
	};
};
