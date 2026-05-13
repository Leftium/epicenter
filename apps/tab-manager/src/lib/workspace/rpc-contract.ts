/**
 * Tab Manager RPC Contract: type-only export for cross-device calls.
 *
 * Import this type in other apps (CLI, desktop, etc.) to get type-safe
 * low-level `rpc.rpc(...)` calls against the tab-manager's actions. Zero
 * runtime cost.
 *
 * @example
 * ```typescript
 * import type { TabManagerRpc } from '@epicenter/tab-manager/rpc';
 *
 * const { data, error } = await workspace.rpc.rpc<TabManagerRpc>(
 *   peer.clientId, 'tabs.close', { tabIds: [1, 2, 3] },
 * );
 * // data is { closedCount: number } | null, fully inferred
 * ```
 */
import type { InferSyncRpcMap } from '@epicenter/workspace';
import type { TabManager } from '../tab-manager/client';

type Actions = TabManager['collaboration']['actions'];

export type TabManagerRpc = InferSyncRpcMap<Actions>;
