/**
 * Honeycrisp project mount.
 *
 * `honeycrisp(opts?)` returns the `Mount` that an
 * `epicenter.config.ts` default-exports. Disk paths follow the
 * Epicenter-root layout: the SQLite mirror at `.epicenter/sqlite/<id>.db`
 * (hidden) and the read-only markdown projection at `<epicenterRoot>/honeycrisp/`
 * (visible), a direct child of the Epicenter root.
 */

import { EPICENTER_API_URL } from '@epicenter/constants/apps';
import { defineActions, defineWorkspace } from '@epicenter/workspace';
import { defineMount } from '@epicenter/workspace/daemon';
import {
	attachGitAutosave,
	attachMarkdownExport,
	type GitAutosaveConfig,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachProjectInfrastructure,
	mountMarkdownPath,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { createHoneycrisp } from './honeycrisp.js';

export type HoneycrispMountOptions = {
	git?: GitAutosaveConfig;
};

export function honeycrisp(opts: HoneycrispMountOptions = {}) {
	return defineMount({
		name: 'honeycrisp',
		kind: 'collaborative',
		open(ctx) {
			const {
				epicenterRoot,
				mount,
				yDocClientId,
				deviceId,
				ownerId,
				keyring,
				openWebSocket,
				onReconnectSignal,
			} = ctx;

			const workspace = createHoneycrisp({ keyring });
			workspace.ydoc.clientID = yDocClientId;

			const sqliteFile = sqlitePath(epicenterRoot, workspace.ydoc.guid);
			const mdDir = mountMarkdownPath(epicenterRoot, mount);

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqliteFile,
				log: createLogger(`${mount}-sqlite`),
			});

			const markdown = attachMarkdownExport(workspace, {
				dir: mdDir,
				tables: { notes: {} },
			});
			if (opts.git) {
				attachGitAutosave({
					ydoc: workspace.ydoc,
					dir: mdDir,
					config: opts.git,
				});
			}

			const actions = defineActions({
				...workspace.actions,
				...sqlite.actions,
				...markdown.actions,
			});

			const infrastructure = attachProjectInfrastructure(workspace.ydoc, {
				baseURL: EPICENTER_API_URL,
				epicenterRoot,
				ownerId,
				deviceId,
				openWebSocket,
				onReconnectSignal,
				actions,
				materializers: [sqlite, markdown],
			});

			return defineWorkspace({
				...workspace,
				...infrastructure,
				markdown,
				actions,
			});
		},
	});
}

export type HoneycrispMount = ReturnType<typeof honeycrisp>;
