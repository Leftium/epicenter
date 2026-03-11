import { DurableObject } from 'cloudflare:workers';
import { decodeSyncRequest, stateVectorsEqual } from '@epicenter/sync';
import * as Y from 'yjs';
import {
	Awareness,
	createConnectionHub,
	createUpdateLog,
} from './room-helpers';

/**
 * Abstract base for Yjs sync rooms backed by Cloudflare Durable Objects.
 *
 * Owns the shared infrastructure that every sync room needs: SQLite update log
 * persistence, WebSocket lifecycle via the Hibernation API, HTTP sync via RPC,
 * and connection management. Subclasses customize via two hooks:
 *
 * - {@link createDoc} — override to set Y.Doc options (e.g., `gc: false`)
 * - {@link initRoom} — override for extra DDL, auto-save, or other setup
 *
 * ## Worker → DO interface
 *
 * The Hono Worker in `app.ts` calls into DOs via two mechanisms:
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
export abstract class BaseSyncRoom extends DurableObject {
	protected doc!: Y.Doc;
	private hub!: ReturnType<typeof createConnectionHub>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		const { sql, transactionSync } = ctx.storage;
		const updateLog = createUpdateLog({ sql, transactionSync });

		ctx.blockConcurrencyWhile(async () => {
			this.doc = this.createDoc();
			const awareness = new Awareness(this.doc);

			updateLog.init(this.doc);

			const onAllDisconnected = this.initRoom(sql);

			this.hub = createConnectionHub({
				ctx,
				doc: this.doc,
				awareness,
				onAllDisconnected,
			});
			this.hub.restoreHibernated();
		});
	}

	/**
	 * Create the Y.Doc instance for this room.
	 *
	 * Override to customize Y.Doc options. For example, use `gc: false` to
	 * preserve delete history for version snapshots.
	 *
	 * @default `new Y.Doc()` (gc: true)
	 */
	protected createDoc(): Y.Doc {
		return new Y.Doc();
	}

	/**
	 * Room-specific initialization hook.
	 *
	 * Called inside `blockConcurrencyWhile` after the doc and update log are
	 * ready but before the connection hub is created. Use this to create
	 * additional tables or set up auto-save tracking.
	 *
	 * @returns A callback invoked when all WebSocket connections disconnect,
	 *          or `undefined` if no action is needed on disconnect.
	 */
	protected initRoom(_sql: SqlStorage): (() => void) | undefined {
		return undefined;
	}

	// --- fetch: WebSocket upgrades only ---

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

	// --- RPC methods (called via stub.sync() / stub.getDoc()) ---

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

	// --- WebSocket lifecycle ---

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
