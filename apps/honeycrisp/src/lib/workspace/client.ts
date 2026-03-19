/**
 * Honeycrisp workspace client — single Y.Doc instance with IndexedDB persistence.
 *
 * Access tables via `workspaceClient.tables.folders` / `workspaceClient.tables.notes`
 * and KV settings via `workspaceClient.kv`. The client is ready when
 * `workspaceClient.whenReady` resolves.
 */

import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { honeycrisp } from './schema';

export default createWorkspace(honeycrisp).withExtension(
	'persistence',
	indexeddbPersistence,
);
