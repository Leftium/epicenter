/**
 * Honeycrisp mount.
 *
 * `honeycrisp(opts?)` returns the `Mount` that an
 * `epicenter.config.ts` default-exports. Disk paths follow the
 * Epicenter-root layout: the SQLite mirror at `.epicenter/sqlite/<id>.db`
 * (hidden) and the read-only markdown projection under table-named folders in
 * the app root.
 */

import { defineActions } from '@epicenter/workspace';
import type { GitAutosaveConfig } from '@epicenter/workspace/document/materializer/markdown';
import {
	attachMountMarkdown,
	attachMountSqlite,
	nodeMountRuntime,
} from '@epicenter/workspace/node';
import { honeycrispWorkspace } from './honeycrisp.js';

export type HoneycrispMountOptions = {
	git?: GitAutosaveConfig;
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function honeycrisp({
	git = false,
	baseURL,
}: HoneycrispMountOptions = {}) {
	return honeycrispWorkspace.mount({
		baseURL,
		runtime: nodeMountRuntime(),
		compose({ workspace, scope }) {
			const sqlite = attachMountSqlite(scope, workspace);
			const markdown = attachMountMarkdown(scope, workspace, {
				tables: { notes: {} },
				git,
			});
			return {
				actions: defineActions({
					...workspace.actions,
					...sqlite.actions,
					...markdown.actions,
				}),
			};
		},
	});
}
