/**
 * Fuji workspace client — single Y.Doc instance with IndexedDB persistence.
 *
 * Access tables via `workspace.tables.entries` and KV settings via
 * `workspace.kv`. The client is ready when `workspace.whenReady`
 * resolves.
 */

import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { createFuji } from './workspace/workspace';

export const workspace = createFuji().withExtension('persistence', indexeddbPersistence);
