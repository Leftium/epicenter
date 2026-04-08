/**
 * Fuji workspace factory — creates a workspace client for the personal CMS.
 *
 * Portable across runtimes. Extension wiring (persistence, sync, markdown
 * materialization) happens at the call site — not here.
 *
 * @example
 * ```typescript
 * import { createFujiWorkspace } from '@epicenter/fuji/workspace';
 *
 * const ws = createFujiWorkspace()
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 */

import { createWorkspace } from '@epicenter/workspace';
import { fujiWorkspace } from './definition';

export function createFujiWorkspace() {
	return createWorkspace(fujiWorkspace);
}
