/**
 * Fuji workspace client — single Y.Doc instance with IndexedDB persistence.
 *
 * Access tables via `workspace.tables.entries` and KV settings via
 * `workspace.kv`. The client is ready when `workspace.whenReady`
 * resolves.
 */

import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { fujiWorkspace } from './workspace/definition';

export const workspace = createWorkspace(fujiWorkspace).withExtension('persistence', indexeddbPersistence);
