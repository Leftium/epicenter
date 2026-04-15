/**
 * Whispering workspace client—single Y.Doc with IndexedDB persistence.
 *
 * On desktop (Tauri), a markdown materializer observes the recordings table
 * and writes `{id}.md` files to the recordings directory. The dir is resolved
 * lazily inside the materializer's whenReady since Tauri path APIs are async.
 */

import { createWorkspace } from '@epicenter/workspace';
import { createMarkdownMaterializer } from '@epicenter/workspace/extensions/materializer/markdown';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { PATHS } from '$lib/constants/paths';
import { whisperingDefinition } from './workspace/definition';
import { serializeRecording } from './workspace/recording-serializer';
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
			}).table('recordings', { serialize: serializeRecording }),
		)
	: base;
