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
 * How a request resolves to the calling user: the one auth seam.
 *
 * The surface wrappers (`requireCookieOrBearerUser`, the rooms bearer with its
 * WebSocket-reject path, `requireBearerUser`) differ only in whether they
 * consult the cookie and how they surface a failure; the user resolution itself
 * is this single function. The deployment builds each wrapper by closing it over
 * its resolver (`requireBearerUser(resolveUser)`), so the resolver is held in the
 * wrapper's closure, not stamped on the context: there is no `c.var.resolveUser`.
 *
 * The cloud closes over the real resolver (`resolveRequestOAuthUser`: an OAuth
 * bearer verified against JWKS); an instance closes over its env-token resolver
 * (`createEnvTokenResolver`). A dev-only entrypoint closes over a trivial
 * `Bearer dev:<userId>` resolver so the runtime-parity smoke needs no interactive
 * login; that bypass lives in a dev entry production never imports, never an
 * env-gated branch in this library.
 *
 * Returns the same `Result<AuthUser, OAuthError>` every resolver returns, so a
 * different resolver slots in without touching the wrappers' error handling
 * (HTTP 401, the OAuth `WWW-Authenticate` challenge, or the rooms 4401 close).
 *
 * Generic over the context it reads: the instance's env-token resolver needs only
 * the portable {@link Env}; the cloud's `resolveRequestOAuthUser` reads `c.var.auth`
 * + `c.var.db`, so it is a `ResolveUser<CloudEnv>`. The wrapper that closes over a
 * resolver carries the same `E`, so a cloud resolver only composes onto a cloud app.
 */
export type ResolveUser<E extends Env = Env> = (
	c: Context<E>,
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
	/**
	 * The relay-exposed (MCP) route names this connection serves, set from the
	 * node's `presence_publish` and mirrored on the wire so peers can auto-mount them
	 * (floor discovery). The floor carries tool routes only (ADR-0078). Undefined
	 * until published; a pure consumer never sets it. Opaque to the relay (forwarded,
	 * never inspected).
	 */
	exposedRoutes?: string[];
};

/**
 * The PORTABLE Hono context, shared by every library sub-app and BOTH
 * deployments. It carries only the variables every deployment populates, so an
 * instance-mounted route can never reach for a cloud-only one (the type does not
 * name it). The cloud's extra relational-auth state lives on {@link CloudEnv}.
 *
 * `Bindings` is the library's own {@link ServerBindings} contract, NOT
 * `Cloudflare.Env`: the library reads only the portable secrets it declares
 * there, so it never names a Cloudflare type (ADR-0066) and a Bun host
 * typechecks with no Cloudflare types in scope. Each deployment's real env
 * (`Cloudflare.Env` on the Workers edges, a parsed `process.env` on Bun) is a
 * superset assignable to this; a Workers resolver that reads a Cloudflare-only
 * binding casts `env` to its own `Cloudflare.Env` at the `apps/*` edge.
 *
 * `Variables` are populated by request-scoped middleware: the resolved origin and
 * trust set, the resolved user, the owner partition, and the runtime-specific
 * rooms registry. The library does NOT carry `planId` (apps/api billing) or any
 * Postgres / Better Auth handle (cloud-only, {@link CloudEnv}).
 */
export type Env = {
	Bindings: ServerBindings;
	Variables: {
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
		rooms: Rooms;
	};
};

/**
 * The CLOUD context: the portable {@link Env} plus the relational-auth state only
 * the hosted cloud composes (Better Auth + Postgres). The single-partition
 * instance composes none of it, so these never appear on the instance's `Env`
 * (ADR-0076): the type makes "the instance reads no cloud secret" a compile fact,
 * not a JSDoc promise. The cloud's auth wrappers, `mountCloudAuth`, `mountCloudDb`,
 * and the `authApp` routes type against this; the portable surfaces stay on `Env`.
 */
export type CloudEnv = {
	Bindings: ServerBindings;
	Variables: Env['Variables'] & {
		/**
		 * The per-request Postgres handle. Populated by `mountCloudDb`. Read by
		 * Better Auth (the only Postgres consumer once room telemetry was deleted).
		 */
		db: NodePgDatabase<typeof schema>;
		/** The per-request Better Auth instance. Populated by `mountCloudAuth`. */
		auth: ReturnType<typeof createAuth>;
		/**
		 * The cloud-only relational-auth secrets ({@link CloudAuthBindings}),
		 * resolved once per request by `mountCloudAuth` from the cloud's own
		 * deploy-gated env so its readers (Better Auth construction and the `authApp`
		 * sign-in page) take them from one resolved value, never the portable `c.env`.
		 */
		authSecrets: CloudAuthBindings;
		/**
		 * Per-request queue of fire-and-forget promises that must outlive the HTTP
		 * response (billing's Autumn charges). `mountCloudDb` drains the whole queue
		 * (`Promise.allSettled(...).then(close)`) through the deployment's
		 * `afterResponse` hook (`executionCtx.waitUntil` on Workers, the live process
		 * on Bun), then closes the db handle. The queue is the data; the hook is how
		 * it is kept alive.
		 */
		afterResponseQueue: Promise<unknown>[];
	};
};
