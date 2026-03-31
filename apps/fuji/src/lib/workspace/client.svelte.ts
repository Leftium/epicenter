/**
 * Fuji workspace client — single Y.Doc instance with IndexedDB persistence.
 *
 * Access tables via `workspaceClient.tables.entries` and KV settings via
 * `workspaceClient.kv`. The client is ready when `workspaceClient.whenReady`
 * resolves.
 */

import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { createFuji } from './workspace';

export default createFuji().withExtension('persistence', indexeddbPersistence);
