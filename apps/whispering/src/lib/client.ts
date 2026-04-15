/**
 * Whispering workspace client — single Y.Doc with IndexedDB persistence.
 *
 * On desktop (Tauri), a markdown materializer observes the recordings table
 * and writes `{id}.md` files to the recordings directory. This keeps the
 * human-readable files in sync with workspace state without the DB service
 * maintaining a parallel metadata copy.
 */

import { createWorkspace } from '@epicenter/workspace';
import { createMarkdownMaterializer } from '@epicenter/workspace/extensions/materializer/markdown';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { PATHS } from '$lib/constants/paths';
import { whisperingDefinition } from './workspace/definition';
import { serializeRecording } from './workspace/recording-serializer';
import { tauriIO, tauriYaml } from './workspace/tauri-materializer-io';

const IS_DESKTOP = !!window.__TAURI_INTERNALS__;

const base = createWorkspace(whisperingDefinition).withExtension(
	'persistence',
	indexeddbPersistence,
);

export const workspace = IS_DESKTOP
	? base.withWorkspaceExtension('materializer', async (ctx) => {
			const dir = await PATHS.DB.RECORDINGS();
			return createMarkdownMaterializer(ctx, { dir, io: tauriIO, yaml: tauriYaml }).table(
				'recordings',
				{ serialize: serializeRecording },
			);
		})
	: base;
