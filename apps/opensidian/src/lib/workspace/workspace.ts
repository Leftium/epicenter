/**
 * Opensidian workspace factory — creates a workspace client from the definition.
 *
 * Returns a non-terminal builder. Consumers chain `.withExtension()` to add
 * persistence, encryption, sync, or other capabilities.
 *
 * @example
 * ```typescript
 * import { createOpensidian } from './workspace'
 *
 * const ws = createOpensidian()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 */

import { createWorkspace } from '@epicenter/workspace';
import { opensidianDefinition } from './definition';


export function createOpensidian() {
	return createWorkspace(opensidianDefinition);
}
