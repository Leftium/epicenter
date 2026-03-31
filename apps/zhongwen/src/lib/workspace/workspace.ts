/**
 * Zhongwen workspace factory — creates a workspace client from the definition.
 *
 * Returns a non-terminal builder. Consumers chain `.withExtension()` to add
 * persistence, encryption, sync, or other capabilities.
 *
 * @example
 * ```typescript
 * import { createZhongwen } from './workspace'
 *
 * const ws = createZhongwen()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 */

import { createWorkspace } from '@epicenter/workspace';
import { definition } from './definition';

export { definition } from './definition';

export function createZhongwen() {
	return createWorkspace(definition);
}
