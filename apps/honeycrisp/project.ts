/**
 * Honeycrisp project mount.
 *
 * `honeycrisp(opts?)` returns the `Mount` that a project's
 * `epicenter.config.ts` default-exports. Default disk paths follow the library
 * convention; options let a project override the markdown directory and
 * SQLite file.
 */

import { isAbsolute, join } from 'node:path';
import { defineActions, defineWorkspace } from '@epicenter/workspace';
import { defineMount } from '@epicenter/workspace/daemon';
import {
	attachMarkdownMaterializer,
	type GitAutosaveConfig,
	slugFilename,
} from '@epicenter/workspace/document/materializer/markdown';
import { attachBunSqliteMaterializer } from '@epicenter/workspace/document/materializer/sqlite';
import {
	attachProjectInfrastructure,
	markdownPath,
	sqlitePath,
} from '@epicenter/workspace/node';
import { createLogger } from 'wellcrafted/logger';
import { createHoneycrisp } from './honeycrisp.js';

export type HoneycrispMountOptions = {
	markdownDir?: string;
	sqliteFile?: string;
	git?: GitAutosaveConfig;
};

export function honeycrisp(opts: HoneycrispMountOptions = {}) {
	return defineMount({
		name: 'honeycrisp',
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

			const workspace = createHoneycrisp({ keyring });
			workspace.ydoc.clientID = yDocClientId;

			const sqliteFile =
				opts.sqliteFile === undefined
					? sqlitePath(projectDir, workspace.ydoc.guid)
					: resolveProjectPath(projectDir, opts.sqliteFile);
			const mdDir =
				opts.markdownDir === undefined
					? markdownPath(projectDir, workspace.ydoc.guid)
					: resolveProjectPath(projectDir, opts.markdownDir);

			const sqlite = attachBunSqliteMaterializer(workspace, {
				filePath: sqliteFile,
				log: createLogger(`${mount}-sqlite`),
			});

			const markdown = attachMarkdownMaterializer(workspace, {
				dir: mdDir,
				perTable: { notes: { filename: slugFilename('title') } },
				git: opts.git,
			});

			const actions = defineActions({
				...workspace.actions,
				...sqlite.actions,
				...markdown.actions,
			});

			const infrastructure = attachProjectInfrastructure(workspace.ydoc, {
				projectDir,
				ownerId,
				deviceId,
				openWebSocket,
				onReconnectSignal,
				actions,
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

function resolveProjectPath(projectDir: string, value: string): string {
	return isAbsolute(value) ? value : join(projectDir, value);
}
