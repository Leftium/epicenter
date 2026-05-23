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
 * This uses the current `defineConfig({ daemon: { routes: { ... } } })` API
 * with a single route. The spec's target API is `defineWorkspace({...})` as
 * the direct default export; that rename is a separate refactor.
 */

import { defineConfig } from '@epicenter/workspace';
import { defineDaemonWorkspace } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachDaemonInfrastructure,
	openWriterSqlite,
} from '@epicenter/workspace/node';
import { openFujiWorkspace } from '@epicenter/fuji';
import { join } from 'node:path';
import { createLogger } from 'wellcrafted/logger';

const fuji = defineDaemonWorkspace({
	async open({
		projectDir,
		route,
		clientId,
		installationId,
		attachEncryption,
		openWebSocket,
	}) {
		const workspace = openFujiWorkspace(attachEncryption, { clientId });

		const infra = attachDaemonInfrastructure(workspace.ydoc, {
			projectDir,
			openWebSocket,
			installationId,
			actions: workspace.actions,
		});

		// Runtime cache: hidden under .epicenter/ at the project root.
		// The spec's future helper is `sqlitePath(projectDir)`; we inline the
		// path here so the example runs against today's package surface.
		const sqliteDb = openWriterSqlite({
			filePath: join(projectDir, '.epicenter', 'sqlite.db'),
			log: createLogger(`${route}-sqlite`),
		});
		workspace.ydoc.once('destroy', () => sqliteDb.close());

		attachSqliteMaterializer(workspace.ydoc, { db: sqliteDb }).table(
			workspace.tables.entries,
		);

		// Markdown: visible at project root, one directory per table.
		// Committed to git as the source of truth. The materializer appends
		// the table name to `dir`, so `dir: projectDir` produces
		// `<projectDir>/entries/<slug>.md` for the `entries` table.
		attachMarkdownMaterializer(workspace.ydoc, {
			dir: projectDir,
		}).table(workspace.tables.entries, { filename: slugFilename('title') });

		return infra;
	},
});

export default defineConfig({
	daemon: {
		routes: { fuji },
	},
});
