import { BaseSyncRoom } from './base-sync-room';

/**
 * Durable Object for generic Yjs sync rooms.
 *
 * Rooms are compact current-state replicas. Apps decide what each Y.Doc
 * means by choosing the room id.
 */
export class SyncRoom extends BaseSyncRoom {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, { gc: true });
	}
}
