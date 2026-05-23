/**
 * Canonical Epicenter project: one workspace, defined inline.
 *
 * Layout (per specs/20260522T220000-workspace-project-layout.md):
 *   epicenter.config.ts       this file: marker + workspace definition
 *   entries/                  table data as markdown (committed)
 *   .epicenter/               runtime cache (gitignored)
 *     yjs.db                  Yjs persistence
 *     sqlite.db               SQL materializer
 *
 * Single-workspace shape: `defineWorkspace` default-exports the workspace
 * definition directly. The host derives the route name from the project
 * directory's basename (`fuji`).
 *
 * Composition is inline so the layout decisions are visible at the project
 * root. Other projects that want the library default paths can call
 * `openFujiDaemon(ctx)` from `@epicenter/fuji/daemon` instead of writing this
 * out by hand.
 */

import { join } from 'node:path';
import {
	createFujiActions,
	FUJI_ID,
	fujiTables,
} from '@epicenter/fuji';
import { defineWorkspace, openEncryptedDoc } from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachDaemonInfrastructure,
	openWriterSqlite,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';

export default defineWorkspace({
	open(ctx) {
		const ws = openEncryptedDoc({
			id: FUJI_ID,
			keyring: ctx.keyring,
			clientId: ctx.clientId,
		});
		const tables = ws.attachTables(fujiTables);
		ws.attachKv({});
		const actions = createFujiActions(tables);

		// Runtime cache: hidden under .epicenter/ at the project root.
		// Inlined so the canonical layout stays visible at the project root.
		const sqliteDb = openWriterSqlite({
			filePath: join(ctx.projectDir, '.epicenter', 'sqlite.db'),
			log: createLogger(`${ctx.route}-sqlite`),
		});
		ws.ydoc.once('destroy', () => sqliteDb.close());

		attachSqliteMaterializer(ws.ydoc, { db: sqliteDb }).table(tables.entries);

		// Markdown: visible at project root, one directory per table.
		// Committed to git as the source of truth. The materializer appends
		// the table name to `dir`, so `dir: projectDir` produces
		// `<projectDir>/entries/<slug>.md` for the `entries` table.
		attachMarkdownMaterializer(ws.ydoc, {
			dir: ctx.projectDir,
		}).table(tables.entries, { filename: slugFilename('title') });

		return attachDaemonInfrastructure(ws.ydoc, {
			projectDir: ctx.projectDir,
			openWebSocket: ctx.openWebSocket,
			installationId: ctx.installationId,
			actions,
		});
	},
});
