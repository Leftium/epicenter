import type { BetterAuthOptions } from 'better-auth';
import { InferPlugin } from 'better-auth/client';
import type { customSession } from 'better-auth/plugins';
import type { AuthSessionResponse } from './contracts/auth-session.js';

/**
 * Compile-time bridge for Better Auth's custom session type inference.
 *
 * `customSessionClient<typeof auth>()` is the canonical pattern but drags in
 * server-only types that client packages in a monorepo cannot resolve.
 * `InferPlugin<T>()` sets the same `$InferServerPlugin` property without
 * requiring a fabricated auth shape.
 */
type EpicenterCustomSessionPlugin = ReturnType<
	typeof customSession<AuthSessionResponse, BetterAuthOptions>
>;

export function epicenterCustomSessionPlugin() {
	return InferPlugin<EpicenterCustomSessionPlugin>();
}
