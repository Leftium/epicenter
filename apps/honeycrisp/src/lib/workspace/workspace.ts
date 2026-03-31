/**
 * Honeycrisp workspace factory — creates a workspace client from the definition.
 *
 * Returns a non-terminal builder. Consumers chain `.withExtension()` to add
 * persistence, encryption, sync, or other capabilities.
 *
 * @example
 * ```typescript
 * import { createHoneycrisp } from '@epicenter/honeycrisp/workspace'
 *
 * const ws = createHoneycrisp()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 */

import { createWorkspace } from '@epicenter/workspace';
import { honeycrisp } from './definition';

export { honeycrisp } from './definition';

export function createHoneycrisp() {
	return createWorkspace(honeycrisp);
}
