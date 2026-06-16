/**
 * Fuji mount.
 *
 * `fuji(opts?)` returns the `Mount` that an `epicenter.config.ts`
 * default-exports. Disk paths follow the Epicenter-root layout: the SQLite
 * mirror lives at `.epicenter/sqlite/<id>.db` (hidden, machine-queried) and the
 * markdown projection at table-named folders under the app root
 * (`<epicenterRoot>/entries/` for Fuji).
 *
 * What `compose` builds:
 *   1. SQLite materializer (`attachMountSqlite`) at the guid-keyed mirror path.
 *   2. Markdown export (`attachMountMarkdown`, read-only, one-way) under the app
 *      root. Each entry's frontmatter is the row; its body is rendered from the
 *      entry's content child doc, read fresh over one-shot HTTP per row and
 *      never persisted on the daemon. There is no import path: the only way to
 *      mutate an entry is through a validated action, never by editing the `.md`.
 *   3. The daemon-served actions: workspace + sqlite + markdown.
 *
 * `.mount()` itself adds the Yjs-log persistence and cloud sync around the same
 * root.
 */

import { defineActions, readRoomOverHttp } from '@epicenter/workspace';
import type { GitAutosaveConfig } from '@epicenter/workspace/document/materializer/markdown';
import {
	attachMountMarkdown,
	attachMountSqlite,
	nodeMountRuntime,
} from '@epicenter/workspace/node';
import { serializeEntryBody } from './entry-body-markdown.js';
import { fujiWorkspace } from './index.js';

export type FujiMountOptions = {
	/** Enable per-materializer Git autosave for markdown output. */
	git?: GitAutosaveConfig;
	/**
	 * Base URL of the Epicenter cloud API used for entry-body reads and sync.
	 * Defaults to `process.env.EPICENTER_API_URL`, falling back to the hosted API.
	 */
	baseURL?: string;
};

export function fuji(opts: FujiMountOptions = {}) {
	return fujiWorkspace.mount({
		baseURL: opts.baseURL,
		runtime: nodeMountRuntime(),
		compose({ workspace, ctx, baseURL }) {
			const sqlite = attachMountSqlite(ctx, workspace);
			const markdown = attachMountMarkdown(ctx, workspace, {
				tables: {
					entries: {
						// One-way render: frontmatter is the row, body is the entry's
						// prose read fresh from its content child doc. The body lives in a
						// separate cloud doc whose guid the workspace derives
						// (`tables.entries.docs.content.guid(id)`); the daemon does not
						// mirror it, so we GET its current snapshot over one-shot HTTP and
						// serialize that. Read every time the row changes; a daemon restart
						// re-reads all bodies, self-healing any `.md` left stale by a
						// cross-doc sync race (root `updatedAt` arriving before the body).
						// A failed or timed-out GET throws, so the materializer skips the
						// write and leaves the existing `.md` intact rather than clobbering
						// it with an empty body.
						toMarkdown: async (entry) => ({
							frontmatter: { ...entry },
							body: await readRoomOverHttp({
								fetch: ctx.session.fetch,
								baseURL,
								ownerId: ctx.session.ownerId,
								guid: workspace.tables.entries.docs.content.guid(entry.id),
								read: (ydoc) =>
									serializeEntryBody(ydoc.getXmlFragment('content')),
							}),
						}),
					},
				},
				git: opts.git ?? false,
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
