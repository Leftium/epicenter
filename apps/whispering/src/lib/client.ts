/**
 * Whispering workspace client — single Y.Doc with IndexedDB persistence.
 *
 * On desktop (Tauri), the recording materializer mirrors the `recordings`
 * table into `{id}.md` files on disk. See `./recording-materializer.ts`.
 */

import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { isTauri } from '@tauri-apps/api/core';
import { createRecordingMaterializer } from './recording-materializer';
import { whisperingDefinition } from './workspace/definition';

const base = createWorkspace(whisperingDefinition).withExtension(
	'persistence',
	indexeddbPersistence,
);

export const workspace = isTauri()
	? base.withExtension('materializer', createRecordingMaterializer)
	: base;
