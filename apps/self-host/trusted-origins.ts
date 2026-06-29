/**
 * The self-host instance trust policy, shared by both runtime entries
 * (`server.ts` on Bun, `worker/index.ts` on Cloudflare) so the two cannot drift.
 *
 * `@epicenter/server` deliberately requires each deployable to declare its own
 * `resolveTrustedOrigins` rather than defaulting one: the set gates CORS, so
 * implicit trust is a security hole. A self-host trusts its OWN origin and the
 * Tauri desktop client, never Epicenter cloud's domains. (The instance composes
 * no Better Auth, so there is no CSRF or open-redirect allowlist to gate here.)
 *
 * Add any browser app origins you serve here (and the Epicenter browser-extension
 * origin, if your users point it at this deployment).
 */
export function resolveSelfHostTrustedOrigins(baseURL: string): string[] {
	return [new URL(baseURL).origin, 'tauri://localhost'];
}
