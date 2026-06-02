/**
 * Wiki markdown vault: the bidirectional desktop projection.
 *
 *   pages/<id>.md   frontmatter IS the page row (core columns + the nested
 *                   `types` cell); the file body IS the page `body` column,
 *                   routed out of frontmatter by the codec below.
 *   types/<id>.md   frontmatter IS the type registry row, including `columns`
 *                   whose `schema` is the TypeBox schema as JSON.
 *
 * Wiring lives here (filesystem-facing) rather than in the isomorphic factory,
 * mirroring how fuji keeps `index.ts` pure and composes IO in `browser.ts`.
 * The `markdown_push` action is the disk-to-Yjs reconcile ("markdown apply"):
 * it reads the files, parses frontmatter, validates against the table schema,
 * and writes rows back into Yjs.
 */

import { attachMarkdownMaterializer } from '@epicenter/workspace/document/materializer/markdown';
import type { WikiWorkspace } from './index';
import { asPageId, isTSchemaObject, type Page, type WikiType } from './schema';

/**
 * Attach the markdown vault to a wiki workspace. Returns the materializer so a
 * caller can `await whenFlushed` and invoke `actions.markdown_push` to reconcile
 * disk edits back into Yjs.
 */
export function attachWikiVault(
	wiki: WikiWorkspace,
	{ dir }: { dir: string | (() => string | Promise<string>) },
) {
	return attachMarkdownMaterializer(
		{ ydoc: wiki.ydoc, tables: wiki.tables },
		{
			dir,
			perTable: {
				types: {
					// Default frontmatter codec, plus a decode gate: a hand-edited
					// type file whose column `schema` is not a JSON object is rejected
					// at import, matching the `types_define` action's own check rather
					// than silently degrading later in projection/lens.
					fromMarkdown: (parsed) => {
						const row = parsed.frontmatter as WikiType;
						for (const spec of row.columns) {
							if (!isTSchemaObject(spec.schema)) {
								throw new Error(
									`type "${row.id}" column "${spec.id}" schema must be a TSchema object`,
								);
							}
						}
						return row;
					},
				},
				pages: {
					// `body` is a row column but belongs in the file body, never in
					// frontmatter; route it across in both directions.
					toMarkdown: (page) => ({
						frontmatter: {
							id: page.id,
							title: page.title,
							description: page.description,
							tags: page.tags,
							source: page.source,
							types: page.types,
							createdAt: page.createdAt,
							updatedAt: page.updatedAt,
						},
						body: page.body.length > 0 ? page.body : undefined,
					}),
					fromMarkdown: (parsed) => {
						const fm = parsed.frontmatter;
						const page: Page = {
							id: asPageId(String(fm.id)),
							title: String(fm.title ?? ''),
							description: (fm.description ?? null) as Page['description'],
							tags: (fm.tags ?? []) as string[],
							source: (fm.source ?? []) as string[],
							types: (fm.types ?? {}) as Page['types'],
							body: parsed.body ?? '',
							createdAt: fm.createdAt as Page['createdAt'],
							updatedAt: fm.updatedAt as Page['updatedAt'],
						};
						return page;
					},
				},
			},
		},
	);
}

export type WikiVault = ReturnType<typeof attachWikiVault>;
