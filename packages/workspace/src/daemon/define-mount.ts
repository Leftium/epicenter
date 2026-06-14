/**
 * `defineMount`: typed entry contract for an app mount inside a project daemon.
 *
 * `epicenter.config.ts` default-exports a `Mount[]`. Each mount carries its own
 * canonical `name`, which
 * becomes the CLI action prefix (`<name>.<action_key>`) and is propagated into
 * the mount context so handlers can use it for logging.
 *
 * The host calls `open(ctx)` once on `epicenter daemon up`. The returned
 * runtime always exposes local `actions`, and may expose `collaboration` when
 * the mount participates in Yjs sync, presence, and peer dispatch.
 */

import type { Keyring } from '@epicenter/encryption';
import type { OwnerId } from '@epicenter/identity';
import type { DeviceId } from '../document/device-id.js';
import type {
	Collaboration,
	OnReconnectSignal,
	OpenWebSocketFn,
} from '../document/open-collaboration.js';
import type { ActionRegistry } from '../shared/actions.js';
import type { AuthedFetch, MaybePromise, ProjectDir } from '../shared/types.js';
import type { DaemonRuntime } from './types.js';

/**
 * Context handed to `open()` for a local-only mount.
 *
 * - `projectDir` is the resolved project root. Source mirrors derive every
 *   absolute local cache path from it.
 * - `mount` is the canonical mount name (`Mount.name`). Pinned here so
 *   handlers can share the same identifier with logs and local cache keys.
 */
export type LocalMountContext = {
	projectDir: ProjectDir;
	mount: string;
};

/**
 * Context handed to `open()` for a collaborative mount.
 *
 * The host owns auth: it refuses collaborative startup when machine auth is
 * signed out, exposes the keyring lookup (with a late-sign-out guard baked
 * into the closure), and passes the auth-derived function refs through for
 * cloud sync.
 */
export type CollaborativeMountContext = LocalMountContext & {
	/**
	 * Deterministic Y.Doc CRDT `clientID` for this daemon, derived from
	 * `projectDir`. Pin it on the Y.Doc with `ydoc.clientID =
	 * ctx.yDocClientId` right after construction.
	 */
	yDocClientId: number;
	/** Conventional collaboration WebSocket device id: `<mount>-daemon`. */
	deviceId: DeviceId;
	/** Workspace owner id snapshotted at startup. */
	ownerId: OwnerId;
	/**
	 * Lazy reader for the current owner keyring. The host's closure throws on
	 * late sign-out so writes fail loud instead of silently losing ciphertext.
	 */
	keyring: () => Keyring;
	/** Opens the relay socket for `openCollaboration`. */
	openWebSocket: OpenWebSocketFn;
	/** Subscribes to auth-state transitions that trigger sync reconnect. */
	onReconnectSignal: OnReconnectSignal;
	/** Auth-owned `fetch` for one-shot HTTP to the relay. */
	fetch: AuthedFetch;
};

export type LocalDaemonRuntime<
	TActions extends ActionRegistry = ActionRegistry,
> = DaemonRuntime<TActions> & {
	readonly collaboration?: never;
};

export type CollaborativeDaemonRuntime<
	TActions extends ActionRegistry = ActionRegistry,
> = DaemonRuntime<TActions> & {
	readonly collaboration: Collaboration<TActions>;
};

/**
 * Local-only app mount. It can serve local daemon actions without Epicenter
 * auth, workspace keys, sync, peers, or a Y.Doc client id.
 */
export type LocalMount<
	TRuntime extends LocalDaemonRuntime = LocalDaemonRuntime,
> = {
	name: string;
	kind: 'local';
	open(ctx: LocalMountContext): MaybePromise<TRuntime>;
};

/**
 * Collaborative app mount. It needs Epicenter auth and receives the full
 * collaborative context before returning a runtime with hosted collaboration.
 */
export type CollaborativeMount<
	TRuntime extends CollaborativeDaemonRuntime = CollaborativeDaemonRuntime,
> = {
	name: string;
	kind: 'collaborative';
	open(ctx: CollaborativeMountContext): MaybePromise<TRuntime>;
};

/**
 * One app mount: a name, a static kind, and an `open(ctx)` that returns a
 * daemon runtime.
 *
 * Factories like `fuji()` return a `Mount`. The canonical mount name lives on
 * the value itself (`Mount.name`), so renaming a project folder never changes
 * the action namespace.
 */
export type Mount = LocalMount | CollaborativeMount;

/**
 * Identity helper that pins a mount so factories preserve their
 * runtime shape and `epicenter.config.ts` gets IntelliSense on the context
 * fields. Pure at the value level.
 */
export function defineMount<TRuntime extends LocalDaemonRuntime>(
	mount: LocalMount<TRuntime>,
): LocalMount<TRuntime>;
export function defineMount<TRuntime extends CollaborativeDaemonRuntime>(
	mount: CollaborativeMount<TRuntime>,
): CollaborativeMount<TRuntime>;
export function defineMount(mount: Mount): Mount {
	return mount;
}
