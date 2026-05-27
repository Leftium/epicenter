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
import { createFujiWorkspace } from '@epicenter/fuji';
import { defineWorkspace, defineWorkspaceBundle } from '@epicenter/workspace';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import { attachDaemonInfrastructure } from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';

export default defineWorkspace({
	open({
		projectDir,
		route,
		yDocClientId,
		deviceId,
		ownerId,
		keyring,
		openWebSocket,
		onReconnectSignal,
	}) {
		const workspace = createFujiWorkspace({ keyring });
		workspace.ydoc.clientID = yDocClientId;

		// Runtime cache: hidden under .epicenter/ at the project root.
		// Inlined so the canonical layout stays visible at the project root.
		attachBunSqliteMaterializer(workspace, {
			filePath: join(projectDir, '.epicenter', 'sqlite.db'),
			log: createLogger(`${route}-sqlite`),
		});

		// Markdown: visible at project root, one directory per table.
		// Committed to git as the source of truth. The materializer appends
		// the table name to `dir`, so `dir: projectDir` produces
		// `<projectDir>/entries/<slug>.md` for the `entries` table.
		attachMarkdownMaterializer(workspace, {
			dir: projectDir,
			perTable: { entries: { filename: slugFilename('title') } },
		});

		const infrastructure = attachDaemonInfrastructure(workspace.ydoc, {
			projectDir,
			ownerId,
			deviceId,
			openWebSocket,
			onReconnectSignal,
			actions: workspace.actions,
		});

		return defineWorkspaceBundle({
			...workspace,
			...infrastructure,
		});
	},
});
