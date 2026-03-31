/**
 * Whispering workspace factory — creates a workspace client from the definition.
 *
 * Returns a non-terminal builder. Consumers chain `.withExtension()` to add
 * persistence, sync, or other capabilities.
 *
 * @example
 * ```typescript
 * import { createWhispering } from './workspace'
 *
 * const ws = createWhispering()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 */

import { createWorkspace } from '@epicenter/workspace';
import { whisperingDefinition } from './definition';


export function createWhispering() {
	return createWorkspace(whisperingDefinition);
}
