/**
 * Library types shared by sub-app factories and middleware.
 *
 * Per-request state lives on the Hono context (`c.var.user`, `c.var.db`,
 * etc.). Per-request `OwnerId` values are reconstructed inside handlers
 * from URL params (in personal mode) or from the literal `'team'` (in
 * team mode), via the `attachOwner` middleware.
 */

import type { AuthUser } from '@epicenter/auth';
import type { OwnerId } from '@epicenter/constants/identity';
import type { ActionManifest } from '@epicenter/workspace';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { createAuth } from './auth/create-auth.js';
import type * as schema from './db/schema/index.js';
import type { Rooms } from './room/contracts.js';

/**
 * Sign-up gating policy.
 *
 * - `open`     : Better Auth accepts new sign-ups normally.
 * - `disabled` : a Better Auth `before` hook rejects every sign-up. The
 *                deployment owner provisions accounts out of band.
 *
 * `invite-only` becomes a third value when the invitation-token system
 * is designed; until that exists, the meaningful gradient is `open` or
 * `disabled`.
 */
export type SignUpPolicy = 'open' | 'disabled';

/**
 * Deployment partition shape. Passed to the sub-apps and middleware that
 * branch on it (`createAssetsApp`, `createAttachOwner`). The wire does not
 * carry mode (consumers derive it from `ownerId === TEAM_OWNER_ID`), so
 * this type stays server-internal.
 */
export type OwnershipMode = 'personal' | 'team';

/**
 * Per-connection identity and runtime state, stamped onto the Cloudflare
 * Durable Object WebSocket attachment so presence survives hibernation.
 *
 * `deviceId` identifies one Epicenter app on one persistent storage scope
 * (browser tab, Tauri window, extension service worker, CLI process; tabs
 * sharing localStorage share an id). The client generates and persists its
 * own; lifespan is the client's concern.
 *
 * `connectedAt` is stamped at upgrade time and surfaced in presence frames so
 * receivers can render an "online since" affordance and tie-break multi-tab
 * same-device (newest wins).
 *
 * `actions` is the published action manifest for this socket. Starts as `{}`
 * at upgrade; updated to the device's manifest when `presence_publish` arrives.
 * Relay treats the value as opaque (it forwards JSON to peers, never inspects).
 *
 * In personal mode every connection to a given DO shares the same `userId`
 * (the DO name partitions by user). In team mode connections carry different
 * `userId` values because every member shares the DO. The DO never branches
 * on which mode it is in.
 */
export type Connection = {
	userId: string;
	deviceId: string;
	connectedAt: number;
	actions: ActionManifest;
};

/**
 * Per-request queue for fire-and-forget promises that must outlive the
 * HTTP response. Populated by handlers via `push`; drained inside
 * `executionCtx.waitUntil` by the base-app's lifecycle middleware so the
 * worker isolate stays alive until every queued promise settles.
 */
export type AfterResponseQueue = {
	/** Enqueue a fire-and-forget promise to run after the response is sent. */
	push(promise: Promise<unknown>): void;
	/** Settle every queued promise via `Promise.allSettled`. */
	drain(): Promise<unknown>;
};

/**
 * Hono context type for every library sub-app.
 *
 * `Bindings` is `Cloudflare.Env`, augmented by each deployment with the
 * exact set of bindings it provides. The library declares the bindings it
 * reads via {@link cloudflare-bindings.d.ts}; cloud-only bindings such as
 * `AUTUMN_SECRET_KEY` are declared in apps/api's generated types and never
 * appear in the library's required set.
 *
 * `Variables` are populated by request-scoped middleware: database client,
 * auth instance, resolved user, after-response queue, and the runtime-
 * specific rooms registry. The library does NOT carry `planId`; that is a
 * cloud-only variable owned by apps/api's billing middleware.
 */
export type Env = {
	Bindings: Cloudflare.Env;
	Variables: {
		db: NodePgDatabase<typeof schema>;
		auth: ReturnType<typeof createAuth>;
		authBaseURL: string;
		user: AuthUser;
		/**
		 * Resolved owner partition for this request. Populated by the
		 * `attachOwner` middleware after auth runs. In personal mode equals
		 * the authenticated user's id; in team mode equals `TEAM_OWNER_ID`.
		 * Handlers read this instead of branching on mode or re-deriving
		 * from the URL `:ownerId` param.
		 */
		ownerId: OwnerId;
		afterResponse: AfterResponseQueue;
		rooms: Rooms;
	};
};
