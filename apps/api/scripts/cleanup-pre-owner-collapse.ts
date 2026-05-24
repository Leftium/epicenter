/**
 * Find pre-Owner-collapse orphans in R2 and the durable_object_instance table.
 *
 * The Owner-partition collapse changed every durable identifier from
 *   personal: `users/<userId>/...`
 *   team:     `<resource>/<id>`           (e.g. `rooms/foo`, `assets/bar`)
 * to a single uniform form:
 *   `owners/<ownerId>/...`
 *
 * Plus the HKDF info-prefix moved from `subject:` to `owner:`, so even if
 * old R2 ciphertext were addressable, its workspace keys would no longer
 * decrypt under the new derivation.
 *
 * Net effect: any data written before either change is unreachable AND
 * unreadable. For deployments that had real data, those rows + objects +
 * Durable Objects need to be enumerated and removed (R2 + DO storage
 * incurs ongoing cost).
 *
 * This script REPORTS orphans. It does NOT delete. The output is a list
 * of names + the wrangler / SQL commands the operator can run to clean
 * up after review.
 *
 * Greenfield deployments with no prior writes will see 0 orphans and
 * report "nothing to do." That is the expected state for the original
 * Epicenter Cloud at this moment in 2026-05.
 *
 * Usage:
 *   cd apps/api
 *   DATABASE_URL=postgres://... bun run scripts/cleanup-pre-owner-collapse.ts
 *   # Or, for prod via Infisical:
 *   infisical run --env=prod --path=/ops -- bun run scripts/cleanup-pre-owner-collapse.ts
 *
 * Why this script does not delete:
 *   - R2: bulk deletion across thousands of keys deserves operator review
 *     before execution. The script prints the wrangler commands to run.
 *   - DOs: Cloudflare has no public "delete DO by name" CLI. DO storage
 *     is only deletable from inside a Worker that owns the binding.
 *     Wiring a one-shot admin route to do that is intentional friction;
 *     the operator should add the route, run it once, then remove it.
 */

import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

const OWNERS_PREFIX = 'owners/';
const ASSETS_BUCKET = 'epicenter-assets';

type OrphanDoRow = {
	do_name: string;
	storage_bytes: number | null;
	last_accessed_at: Date;
};

async function findOrphanedDoRecords(databaseUrl: string): Promise<OrphanDoRow[]> {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const { rows } = await client.query<OrphanDoRow>(
			`SELECT do_name, storage_bytes, last_accessed_at
			 FROM durable_object_instance
			 WHERE do_name NOT LIKE $1
			 ORDER BY last_accessed_at DESC`,
			[`${OWNERS_PREFIX}%`],
		);
		return rows;
	} finally {
		await client.end();
	}
}

function listR2Keys(bucket: string): string[] {
	const result = spawnSync(
		'bunx',
		['wrangler', 'r2', 'object', 'list', bucket, '--remote'],
		{ encoding: 'utf-8' },
	);
	if (result.status !== 0) {
		throw new Error(`wrangler r2 list failed: ${result.stderr}`);
	}
	// `wrangler r2 object list` output format: one key per line, plus header
	// lines that start with "Listing" or contain whitespace columns. Filter
	// to plain key strings.
	return result.stdout
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter((line) => !line.startsWith('Listing'))
		.filter((line) => !line.includes(' '));
}

async function main() {
	const databaseUrl = process.env['DATABASE_URL'];
	if (!databaseUrl) {
		console.error(
			'DATABASE_URL is required. For prod, wrap with `infisical run --env=prod --path=/ops --`.',
		);
		process.exit(1);
	}

	console.log('=== Phase 1: Durable Object instance orphans ===');
	const orphanRows = await findOrphanedDoRecords(databaseUrl);
	if (orphanRows.length === 0) {
		console.log('No orphaned durable_object_instance rows. Nothing to do.\n');
	} else {
		console.log(
			`Found ${orphanRows.length} orphaned DO records (do_name not starting with "owners/"):`,
		);
		for (const row of orphanRows) {
			const bytes = row.storage_bytes ?? '?';
			console.log(
				`  ${row.do_name}  (${bytes} bytes, last access ${row.last_accessed_at.toISOString()})`,
			);
		}
		console.log(`
Step 1: wipe DO storage from inside the Worker. Add a one-shot admin
route to apps/api (auth-gated, removed after one run):

  // apps/api/src/index.ts, temporarily
  app.post('/__admin/wipe-orphan-do', requireBearerUser, async (c) => {
    const orphanNames = [
${orphanRows.map((row) => `      ${JSON.stringify(row.do_name)},`).join('\n')}
    ];
    for (const name of orphanNames) {
      const id = c.env.ROOM.idFromName(name);
      await c.env.ROOM.get(id).fetch('https://internal/__wipe', { method: 'POST' });
    }
    return c.json({ wiped: orphanNames.length });
  });

The Room DO needs to handle '/__wipe' by calling ctx.storage.deleteAll().

Step 2: drop the database rows AFTER the storage wipe succeeds:

  DELETE FROM durable_object_instance WHERE do_name NOT LIKE 'owners/%';

Step 3: remove the admin route and the /__wipe handler.
`);
	}

	console.log('=== Phase 2: R2 asset orphans ===');
	let allKeys: string[];
	try {
		allKeys = listR2Keys(ASSETS_BUCKET);
	} catch (cause) {
		console.error(String(cause));
		process.exit(1);
	}
	const orphanKeys = allKeys.filter((key) => !key.startsWith(OWNERS_PREFIX));

	if (orphanKeys.length === 0) {
		console.log('No orphaned R2 keys. Nothing to do.\n');
	} else {
		console.log(`Found ${orphanKeys.length} orphaned R2 keys:`);
		for (const key of orphanKeys) {
			console.log(`  ${key}`);
		}
		console.log(`
To delete them after review, the safest pattern is bulk by prefix:

  bunx wrangler r2 object delete ${ASSETS_BUCKET} --prefix users/ --remote
  bunx wrangler r2 object delete ${ASSETS_BUCKET} --prefix assets/ --remote

(Any other top-level prefixes the list shows above also need their own
delete commands.)
`);
	}

	if (orphanRows.length === 0 && orphanKeys.length === 0) {
		console.log('All clean. The deployment has no pre-Owner-collapse orphans.');
	}
}

await main();
