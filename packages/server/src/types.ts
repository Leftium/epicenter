/**
 * Library types shared by sub-app factories and middleware.
 *
 * Per-request state lives on the Hono context (`c.var.user`, `c.var.db`,
 * etc.). The `requireOwnership` middleware resolves the owner partition
 * from `(mode, c.var.user.id)`, rejects URL `:ownerId` mismatches at
 * the boundary, and stashes the result on `c.var.ownerId`.
 */

import type { AuthUser, UserId } from '@epicenter/auth';
import type { OAuthError } from '@epicenter/constants/oauth-errors';
import type { OwnerId } from '@epicenter/identity';
import type { ActionManifest } from '@epicenter/workspace';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Context } from 'hono';
import type { Result } from 'wellcrafted/result';
import type { CloudAuthBindings, createAuth } from './auth/create-auth.js';
import type * as schema from './db/schema/index.js';
import type { Rooms } from './room/contracts.js';
import type { ServerBindings } from './server-bindings.js';

/**
 * How a request resolves to the calling user: the one injected auth seam.
 *
 * The surface wrappers (`requireCookieOrBearerUser`, the rooms bearer with its
 * WebSocket-reject path, `requireBearerUser`) differ only in whether they
 * consult the cookie and how they surface a failure; the user resolution itself
 * is this single function. The deployment injects it once on `createServerApp`,
 * which stamps it onto `c.var.resolveUser`; every wrapper reads it from there
 * rather than calling a hardcoded resolver, so all three honor the injection.
 *
 * Production passes nothing and gets the real resolver (`resolveRequestOAuthUser`:
 * an OAuth bearer verified against JWKS). A dev-only entrypoint injects a trivial
 * `Bearer dev:<userId>` resolver so the runtime-parity smoke needs no interactive
 * login; that bypass lives in a dev entry production never imports, never an
 * env-gated branch in this library.
 *
 * Returns the same `Result<AuthUser, OAuthError>` the real resolver returns, so
 * an injected resolver slots in without touching the wrappers' error handling
 * (HTTP 401, the OAuth `WWW-Authenticate` challenge, or the rooms 4401 close).
 */
export type ResolveUser = (
	c: Context<Env>,
) => Promise<Result<AuthUser, OAuthError>>;

/**
 * Per-connection identity and runtime state, stamped onto the Cloudflare
 * Durable Object WebSocket attachment so presence survives hibernation.
 *
 * `nodeId` identifies one Epicenter app on one persistent storage scope
 * (browser tab, Tauri window, extension service worker, CLI process; tabs
 * sharing localStorage share an id). The client generates and persists its
 * own; lifespan is the client's concern.
 *
 * `connectedAt` is stamped at upgrade time and surfaced in presence frames so
 * receivers can render an "online since" affordance and tie-break multi-tab
 * same-node (newest wins).
 *
 * `actions` is the published action manifest for this socket. Starts as `{}`
 * at upgrade; updated to the node's manifest when `presence_publish` arrives.
 * Relay treats the value as opaque (it forwards JSON to peers, never inspects).
 *
 * In personal mode every connection to a given DO shares the same `userId`
 * (the DO name partitions by user). On an instance every connection resolves to
 * the one pinned partition; the DO is owner-blind and never branches on which
 * deployment it is.
 */
export type Connection = {
	userId: UserId;
	nodeId: string;
	connectedAt: number;
	actions: ActionManifest;
	/**
	 * The catalog agent this connection answers as (ADR-0025), set from the
	 * node's `presence_publish` and mirrored on the wire so a picker can decorate
	 * a durable agent as live. Undefined until published; ordinary participants
	 * never set it. Opaque to the relay (forwarded, never inspected).
	 */
	agentId?: string;
};

/**
 * Hono context type for every library sub-app.
 *
 * `Bindings` is the library's own {@link ServerBindings} contract, NOT
 * `Cloudflare.Env`: the library reads only the portable secrets it declares
 * there, so it never names a Cloudflare type (ADR-0066) and a Bun host
 * typechecks with no Cloudflare types in scope. Each deployment's real env
 * (`Cloudflare.Env` on the Workers edges, a parsed `process.env` on Bun) is a
 * superset assignable to this; a Workers resolver that reads a Cloudflare-only
 * binding casts `env` to its own `Cloudflare.Env` at the `apps/*` edge.
 *
 * `Variables` are populated by request-scoped middleware: database client,
 * auth instance, resolved user, after-response queue, and the runtime-
 * specific rooms registry. The library does NOT carry `planId`; that is a
 * cloud-only variable owned by apps/api's billing middleware.
 */
export type Env = {
	Bindings: ServerBindings;
	Variables: {
		/**
		 * The per-request Postgres handle. Populated by `createServerApp`'s db
		 * lifecycle middleware, installed ONLY when the runtime provides a `db` leg
		 * (the cloud does; the single-partition instance composes no Postgres, so this
		 * is never set on an instance, ADR-0074). Read by Better Auth and the room
		 * telemetry recorder, both cloud-only.
		 */
		db: NodePgDatabase<typeof schema>;
		/**
		 * The per-request Better Auth instance. Populated by `mountCloudAuth`, the
		 * cloud-only relational-auth layer; the single-partition instance composes
		 * no Better Auth, so this is never set on an instance and no instance-mounted
		 * route reads it (ADR-0074). Like every variable here, reading it before its
		 * installing middleware ran is a bug.
		 */
		auth: ReturnType<typeof createAuth>;
		/**
		 * The cloud-only relational-auth secrets ({@link CloudAuthBindings}),
		 * resolved once per request by `mountCloudAuth` from the cloud's own
		 * deploy-gated env and stamped here so the cloud-only readers (Better Auth
		 * construction and the `authApp` sign-in page) take them from one resolved
		 * value, never from the portable `c.env` bag. Like `auth` and `db`, this is
		 * set only by the cloud layer and is never present on the single-partition
		 * instance, which composes no Better Auth and reads no auth secret (ADR-0075).
		 */
		authSecrets: CloudAuthBindings;
		authBaseURL: string;
		/**
		 * Origins this deployment trusts for CORS, cookie-mutation CSRF, and
		 * Better Auth's redirect allow-list. Supplied by the deployment
		 * (`createServerApp`'s `resolveTrustedOrigins`), never hardcoded in the
		 * library: a self-host trusts its own origins, not Epicenter cloud's.
		 */
		trustedOrigins: string[];
		user: AuthUser;
		/**
		 * Resolved owner partition for this request. Populated by the
		 * `requireOwnership` middleware after auth runs. In personal mode
		 * equals the authenticated user's id; on an instance equals
		 * `INSTANCE_OWNER_ID`. Handlers read this instead of branching on
		 * mode or re-deriving from the URL `:ownerId` param.
		 */
		ownerId: OwnerId;
		/**
		 * Per-request queue of fire-and-forget promises that must outlive the
		 * HTTP response. Handlers push promises (typically DB writes that use
		 * `c.var.db`); the server-app lifecycle middleware drains the whole
		 * queue (`Promise.allSettled(...).then(close)`) through the injected
		 * `afterResponse` hook, which keeps it alive past the response
		 * (`executionCtx.waitUntil` on Workers, the live process on Bun). Named
		 * distinctly from that `afterResponse` scheduler hook: this is the queue,
		 * the hook is how the queue is drained. Installed alongside `c.var.db` by the
		 * cloud-only db lifecycle middleware, so it is never set on a Postgres-free
		 * instance (ADR-0074).
		 */
		afterResponseQueue: Promise<unknown>[];
		rooms: Rooms;
		/**
		 * How this deployment resolves a request to its calling user, stamped by
		 * `createServerApp` (the cloud passes the OAuth bearer resolver, an instance
		 * its token resolver, ADR-0074). The auth wrappers read it here instead of
		 * hardcoding a resolver, so a dev entry can inject a trivial bearer resolver
		 * without the wrappers changing. See {@link ResolveUser}.
		 */
		resolveUser: ResolveUser;
	};
};
