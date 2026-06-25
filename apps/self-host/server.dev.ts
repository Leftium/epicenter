/**
 * Dev-only Bun entrypoint: the self-host server with the `Bearer dev:<userId>`
 * resolver injected, so a runtime smoke can drive the authed surfaces without
 * Google OAuth or a forged session.
 *
 * It boots the SAME {@link startSelfHostServer} production uses, passing only the
 * dev `resolveUser`. This is the ONLY file that imports the credential bypass
 * ({@link resolveDevUser}); the production entrypoints (`worker/index.ts`,
 * `server.ts`) never do, so the bypass cannot ship. Run it explicitly
 * (`bun server.dev.ts`, or `bun run dev:bun:devauth`); never wire it into a
 * production process.
 */

import { resolveDevUser } from './dev-auth.js';
import { startSelfHostServer } from './server.js';

console.warn(
	'apps/self-host (Bun) DEV AUTH: Bearer dev:<userId> resolves a synthetic user on localhost. Never run this in production.',
);

startSelfHostServer({ resolveUser: resolveDevUser });
