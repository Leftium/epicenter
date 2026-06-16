/**
 * Tab Manager mount.
 *
 * `tabManager(opts?)` returns the Mount used by `epicenter.config.ts`.
 * It projects saved tabs, bookmarks, and devices into markdown while keeping
 * the Y.Doc update log and SQLite mirror under `.epicenter/`. The daemon serves
 * only the materializer actions: Tab Manager's tab/bookmark actions are
 * browser-only and live in `tab-manager/extension.ts`.
 */

import { defineActions } from '@epicenter/workspace';
import type { GitAutosaveConfig } from '@epicenter/workspace/document/materializer/markdown';
import {
	attachMountMarkdown,
	attachMountSqlite,
	nodeMountRuntime,
} from '@epicenter/workspace/node';
import { tabManagerWorkspace } from './src/lib/workspace/definition.js';

export type TabManagerMountOptions = {
	/** Enable per-materializer Git autosave for markdown output. */
	git?: GitAutosaveConfig;
	/**
	 * Base URL of the Epicenter cloud API used for sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function tabManager({
	git = false,
	baseURL,
}: TabManagerMountOptions = {}) {
	return tabManagerWorkspace.mount({
		baseURL,
		runtime: nodeMountRuntime(),
		compose({ workspace, ctx }) {
			const sqlite = attachMountSqlite(ctx, workspace, {
				fts: {
					bookmarks: ['title', 'url'],
					savedTabs: ['title', 'url'],
				},
			});
			const markdown = attachMountMarkdown(ctx, workspace, {
				tables: {
					bookmarks: {},
					devices: {},
					savedTabs: {},
				},
				git,
			});
			return {
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
