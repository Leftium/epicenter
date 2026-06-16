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
import { nodeMountRuntime } from '@epicenter/workspace/node';
import { honeycrispWorkspace } from './honeycrisp.js';

export type HoneycrispMountOptions = {
	git?: GitAutosaveConfig;
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function honeycrisp(opts: HoneycrispMountOptions = {}) {
	return honeycrispWorkspace.mount({
		name: 'honeycrisp',
		baseURL: opts.baseURL,
		runtime: nodeMountRuntime(),
		compose({ workspace, runtime }) {
			const sqlite = runtime.sqlite(workspace);
			const markdown = runtime.markdown(workspace, {
				tables: { notes: {} },
				git: opts.git ?? false,
			});
			return {
				expose: { markdown },
				materializers: [sqlite, markdown],
				actions: defineActions({
					...workspace.actions,
					...sqlite.actions,
					...markdown.actions,
				}),
			};
		},
	});
}
