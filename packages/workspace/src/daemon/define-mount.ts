/**
 * `defineMount`: the entry contract for an app mount inside the daemon.
 *
 * `epicenter.config.ts` default-exports a `Mount[]`. Each mount carries its own
 * canonical `name`, which becomes the CLI action prefix (`<name>.<action_key>`)
 * and is propagated into the mount context so handlers can use it for logging.
 *
 * The host calls `open(ctx)` once on `epicenter daemon up`. A mount can do one
 * of two things:
 *
 *   - return a `DaemonRuntime` (`actions`, optionally `collaboration`), or
 *   - return `inactive(reason)` to say "I cannot run right now," typically
 *     because it needs a signed-in `session` and there is none.
 *
 * There is no `local` vs `collaborative` kind. A mount asks `ctx.session` for
 * what it needs: a purely local mirror ignores it, a mount that wants the peer
 * plane (presence + remote dispatch) uses its socket, and a mount that stores
 * encrypted workspace data uses its keyring. The session is `null` when machine
 * auth is signed out, so the logged-out case is always in front of the author.
 */

import type { Keyring } from '@epicenter/encryption';
import type { OwnerId } from '@epicenter/identity';
import type { DeviceId } from '../document/device-id.js';
import type {
	OnReconnectSignal,
	OpenWebSocketFn,
} from '../document/open-collaboration.js';
import type {
	AuthedFetch,
	EpicenterRoot,
	MaybePromise,
} from '../shared/types.js';
import type { DaemonRuntime } from './types.js';

/**
 * The signed-in capability kit a mount needs to join the peer plane or read its
 * encrypted workspace. Present on the context only while machine auth is
 * signed in.
 *
 * - `keyring` is the lazy reader for the current owner keyring. The host's
 *   closure throws on late sign-out so writes fail loud instead of silently
 *   losing ciphertext. Needed only by mounts that store encrypted data.
 * - `openWebSocket` / `onReconnectSignal` / `fetch` are the auth-owned transport
 *   refs forwarded into `openCollaboration` for sync, presence, and dispatch.
 * - `ownerId`, `deviceId`, and `yDocClientId` pin this mount's identity on the
 *   Y.Doc (`ydoc.clientID = session.yDocClientId`).
 */
export type MountSession = {
	readonly ownerId: OwnerId;
	/** Conventional collaboration WebSocket device id: `<mount>-daemon`. */
	readonly deviceId: DeviceId;
	/** Deterministic Y.Doc CRDT `clientID` for this daemon, from `epicenterRoot`. */
	readonly yDocClientId: number;
	keyring(): Keyring;
	readonly openWebSocket: OpenWebSocketFn;
	readonly onReconnectSignal: OnReconnectSignal;
	readonly fetch: AuthedFetch;
};

/**
 * Context handed to every `open()`.
 *
 * - `epicenterRoot` is the resolved Epicenter root (the folder that holds
 *   `epicenter.config.ts`). Disk-writing helpers derive every absolute path
 *   from it.
 * - `mount` is the canonical mount name (`Mount.name`), pinned so handlers
 *   share one identifier with logs and local cache keys.
 * - `session` is the signed-in capability kit, or `null` when signed out.
 */
export type MountContext = {
	readonly epicenterRoot: EpicenterRoot;
	readonly mount: string;
	readonly session: MountSession | null;
};

/**
 * "I cannot run right now." A mount returns this from `open()` instead of a
 * runtime when a precondition (usually a signed-in `session`) is missing. The
 * daemon starts every sibling that did open and reports the inactive ones; it
 * is not a crash and does not abort startup.
 */
export type MountInactive = {
	readonly inactive: true;
	readonly reason: string;
};

/** Build the `MountInactive` signal an `open()` returns when it cannot run. */
export function inactive(reason: string): MountInactive {
	return { inactive: true, reason };
}

/** Narrow an `open()` result to the inactive branch. */
export function isInactive(
	result: DaemonRuntime | MountInactive,
): result is MountInactive {
	return 'inactive' in result;
}

/**
 * One app mount: a name and an `open(ctx)` that returns a daemon runtime or
 * `inactive(reason)`.
 *
 * Factories like `fuji()` return a `Mount`. The canonical mount name lives on
 * the value itself (`Mount.name`), so renaming an Epicenter folder never
 * changes the action namespace.
 */
export type Mount = {
	name: string;
	open(ctx: MountContext): MaybePromise<DaemonRuntime | MountInactive>;
};

/**
 * Identity helper that pins a mount so factories preserve their shape and
 * `epicenter.config.ts` gets IntelliSense on the context fields. Pure at the
 * value level.
 */
export function defineMount(mount: Mount): Mount {
	return mount;
}
