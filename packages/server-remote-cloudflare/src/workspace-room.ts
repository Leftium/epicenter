import { BaseYjsRoom } from './base-room';

/**
 * Durable Object for workspace metadata documents.
 *
 * Uses `gc: true` to keep docs small — workspace metadata is structured
 * (tables, KV, awareness) and doesn't need version history.
 */
export class WorkspaceRoom extends BaseYjsRoom {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, { gc: true });
	}
}
