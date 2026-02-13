import { suspendedTabs } from './suspended-tabs';
import { tabs } from './tabs';

/**
 * Unified namespace for all query operations.
 * Provides a single entry point for all TanStack Query-based operations.
 *
 * Usage:
 * ```typescript
 * import { rpc } from '$lib/query';
 *
 * // Reactive (in components)
 * const tabsQuery = createQuery(() => rpc.tabs.getAll.options);
 * const suspendedQuery = createQuery(() => rpc.suspendedTabs.getAll.options);
 *
 * // Imperative (anywhere)
 * const { data, error } = await rpc.tabs.close.execute(tabId);
 * ```
 */
export const rpc = {
	tabs,
	suspendedTabs,
};

// Re-export query client for direct access if needed
export { queryClient } from './_client';
