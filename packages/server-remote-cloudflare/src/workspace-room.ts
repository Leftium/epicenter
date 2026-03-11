import { DurableObject } from 'cloudflare:workers';
import { decodeSyncRequest, stateVectorsEqual } from '@epicenter/sync';
import * as Y from 'yjs';
import {
	Awareness,
	createConnectionHub,
	createUpdateLog,
} from './room-helpers';

/**
 * Durable Object for workspace metadata documents (`gc: true`).
 *
 * Workspace docs hold structured metadata (tables, KV, awareness) and don't
 * need version history. GC keeps docs small by discarding deleted item
 * structures.
 *
 * Each instance maps to one room ID via `idFromName(roomId)` and hosts a
 * single in-memory `Y.Doc`. Uses the WebSocket Hibernation API so connections
 * stay alive while the DO pays zero compute when idle.
 *
 * ## Worker → DO interface
 *
 * The Hono Worker in `app.ts` calls into this DO via two mechanisms:
 *
 * - **RPC** (`stub.sync()`, `stub.getDoc()`) — for HTTP sync and snapshot
 *   bootstrap. Direct method calls avoid Request/Response serialization
 *   overhead for binary payloads. The Worker handles HTTP concerns (status
 *   codes, content-type headers); the DO handles only Yjs logic.
 * - **fetch** (`stub.fetch(request)`) — for WebSocket upgrades only, since
 *   the 101 Switching Protocols handshake requires HTTP request/response
 *   semantics. After upgrade, all sync traffic flows through the Hibernation
 *   API callbacks (`webSocketMessage`, `webSocketClose`, `webSocketError`).
 *
 * ## Storage model
 *
 * Append-only update log in DO SQLite with opportunistic cold-start
 * compaction. See `createUpdateLog` in `room-helpers.ts` for full details.
 *
 * ## Auth & room isolation
 *
 * Handled upstream by `authGuard` middleware in app.ts. The Worker validates
 * the session (cookie or `?token=` query param for WebSocket) via Better Auth
 * before calling RPC methods or forwarding fetch. The DO itself does not
 * re-validate — it trusts the Worker boundary.
 *
 * Room names are user-scoped: the Worker prefixes `user:{userId}:` to the
 * client-provided room name before calling `idFromName()`. This ensures each
 * user's documents are isolated in separate DO instances, even if multiple
 * users create documents with the same name (e.g., "tab-manager").
 *
 * We chose user-scoped keys (Google Docs model) over org-scoped keys
 * (Vercel/Supabase model) because most workspaces hold personal data.
 * For enterprise self-hosted, the deployment itself is the org boundary.
 * See `getWorkspaceStub` in app.ts for the full rationale.
 */
export class WorkspaceRoom extends DurableObject {
	private doc!: Y.Doc;
	private hub!: ReturnType<typeof createConnectionHub>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		// Auto ping/pong without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		const { sql, transactionSync } = ctx.storage;

		const updateLog = createUpdateLog({ sql, transactionSync });

		this.ctx.blockConcurrencyWhile(async () => {
			this.doc = new Y.Doc();
			const awareness = new Awareness(this.doc);

			updateLog.init(this.doc);

			this.hub = createConnectionHub({
				ctx: this.ctx,
				doc: this.doc,
				awareness,
			});
			this.hub.restoreHibernated();
		});
	}

	/**
	 * Only handles WebSocket upgrades. HTTP operations (sync, snapshot) are
	 * exposed as RPC methods called directly on the stub, avoiding the overhead
	 * of constructing/parsing Request/Response objects for binary payloads.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.hub.upgrade();
		}
		return new Response('Method not allowed', { status: 405 });
	}

	/**
	 * HTTP sync via RPC.
	 *
	 * Binary body format: `[length-prefixed stateVector][length-prefixed update]`
	 * (encoded via `encodeSyncRequest` from sync-core).
	 *
	 * 1. Applies client update to the live doc (triggers `updateV2` → SQLite
	 *    persist + broadcast to WebSocket peers).
	 * 2. Compares state vectors — returns `null` if already in sync (caller
	 *    maps to 304).
	 * 3. Otherwise returns the binary diff the client is missing.
	 */
	async sync(body: Uint8Array): Promise<Uint8Array | null> {
		const { stateVector: clientSV, update } = decodeSyncRequest(body);

		if (update.byteLength > 0) {
			Y.applyUpdateV2(this.doc, update, 'http');
		}

		const serverSV = Y.encodeStateVector(this.doc);
		if (stateVectorsEqual(serverSV, clientSV)) {
			return null;
		}

		return Y.encodeStateAsUpdateV2(this.doc, clientSV);
	}

	/**
	 * Snapshot bootstrap via RPC.
	 *
	 * Returns the full doc state via `Y.encodeStateAsUpdateV2`. Clients apply
	 * this with `Y.applyUpdateV2` to hydrate their local doc before opening a
	 * WebSocket, reducing the initial sync payload size.
	 */
	async getDoc(): Promise<Uint8Array> {
		return Y.encodeStateAsUpdateV2(this.doc);
	}

	override async webSocketMessage(
		ws: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		this.hub.dispatch(ws, message);
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		this.hub.close(ws, code, reason);
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		this.hub.error(ws);
	}
}
