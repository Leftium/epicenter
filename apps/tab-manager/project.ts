/**
 * Tab Manager project mount.
 *
 * `tabManager(opts?)` returns the Mount used by `epicenter.config.ts`.
 * It projects saved tabs, bookmarks, and devices into markdown while keeping
 * the Y.Doc update log and SQLite mirror under `.epicenter/`.
 */

import { isAbsolute, join } from 'node:path';
import { defineWorkspace } from '@epicenter/workspace';
import { defineMount } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachProjectInfrastructure,
	markdownPath,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { createTabManagerWorkspace } from './src/lib/workspace/definition.js';

export type TabManagerMountOptions = {
	/** Markdown directory; relative paths resolve against `projectDir`. */
	markdownDir?: string;
	/** SQLite file path; relative paths resolve against `projectDir`. */
	sqliteFile?: string;
};

export function tabManager(opts: TabManagerMountOptions = {}) {
	return defineMount({
		name: 'tab-manager',
		open(ctx) {
			const {
				projectDir,
				mount,
				yDocClientId,
				deviceId,
				ownerId,
				keyring,
				openWebSocket,
				onReconnectSignal,
			} = ctx;

			const workspace = createTabManagerWorkspace({ keyring });
			workspace.ydoc.clientID = yDocClientId;

			const sqliteFile =
				opts.sqliteFile === undefined
					? sqlitePath(projectDir, workspace.ydoc.guid)
					: resolveProjectPath(projectDir, opts.sqliteFile);
			const mdDir =
				opts.markdownDir === undefined
					? markdownPath(projectDir, workspace.ydoc.guid)
					: resolveProjectPath(projectDir, opts.markdownDir);

			attachBunSqliteMaterializer(workspace, {
				filePath: sqliteFile,
				fts: {
					bookmarks: ['title', 'url'],
					savedTabs: ['title', 'url'],
				},
				log: createLogger(`${mount}-sqlite`),
			});
			attachMarkdownMaterializer(workspace, {
				dir: mdDir,
				perTable: {
					bookmarks: { filename: slugFilename('title') },
					devices: {},
					savedTabs: { filename: slugFilename('title') },
				},
			});

			const infrastructure = attachProjectInfrastructure(workspace.ydoc, {
				projectDir,
				ownerId,
				deviceId,
				openWebSocket,
				onReconnectSignal,
				actions: {},
			});

			return defineWorkspace({
				...workspace,
				...infrastructure,
			});
		},
	});
}

export type TabManagerMount = ReturnType<typeof tabManager>;

function resolveProjectPath(projectDir: string, value: string): string {
	return isAbsolute(value) ? value : join(projectDir, value);
}
