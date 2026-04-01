/**
 * Fuji workspace factory — creates a workspace client from the definition.
 *
 * Returns a non-terminal builder. Consumers chain `.withExtension()` to add
 * persistence, encryption, sync, or other capabilities.
 *
 * @example
 * ```typescript
 * import { createFuji } from './workspace'
 *
 * const ws = createFuji()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 */

import { createWorkspace } from '@epicenter/workspace';
import { fujiWorkspace } from './definition';


export function createFuji() {
	return createWorkspace(fujiWorkspace);
}
