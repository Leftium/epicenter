import { BaseSyncRoom } from './base-sync-room';

/**
 * Durable Object for workspace metadata documents (`gc: true`).
 *
 * Workspace docs hold structured metadata (tables, KV, awareness) and don't
 * need version history. GC keeps docs small by discarding deleted item
 * structures.
 *
 * Uses all defaults from {@link BaseSyncRoom} — no config needed.
 */
export class WorkspaceRoom extends BaseSyncRoom {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, { gc: true });
		this.initHub();
	}
}
