/**
 * Whispering workspace client—single Y.Doc with IndexedDB persistence.
 *
 * On desktop (Tauri), a markdown materializer observes the recordings table
 * and writes `{id}.md` files to the recordings directory. The dir is resolved
 * lazily inside the materializer's whenReady since Tauri path APIs are async.
 */

import { createWorkspace } from '@epicenter/workspace';
import {
	createMarkdownMaterializer,
	type SerializeResult,
} from '@epicenter/workspace/extensions/materializer/markdown';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { PATHS } from '$lib/constants/paths';
import type { Recording } from './workspace';
import { whisperingDefinition } from './workspace/definition';
import { tauriIO, tauriYaml } from './workspace/tauri-materializer-io';

const base = createWorkspace(whisperingDefinition).withExtension(
	'persistence',
	indexeddbPersistence,
);

export const workspace = window.__TAURI_INTERNALS__
	? base.withWorkspaceExtension('materializer', (ctx) =>
			createMarkdownMaterializer(ctx, {
				dir: () => PATHS.DB.RECORDINGS(),
				io: tauriIO,
				yaml: tauriYaml,
			}).table('recordings', {
				serialize: (row: Recording): SerializeResult => {
					const { transcript, _v, ...frontmatter } = row;
					const yamlStr = tauriYaml.stringify(frontmatter);
					const yamlBlock = yamlStr.endsWith('\n') ? yamlStr : `${yamlStr}\n`;
					return {
						filename: `${row.id}.md`,
						content: `---\n${yamlBlock}---\n${transcript || ''}\n`,
					};
				},
			}),
		)
	: base;
