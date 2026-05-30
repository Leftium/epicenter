import type { BetterAuthOptions } from 'better-auth';

export const AUTH_BASE_PATH = '/auth';

/** Shared Better Auth config used by both the runtime and the CLI schema tool. */
export const BASE_AUTH_CONFIG = {
	basePath: AUTH_BASE_PATH,
	// Email/password is intentionally disabled. Google is the only sign-in
	// method, and Google asserts a verified email at the IdP. Enabling local
	// credentials here reopens an account-takeover path: better-auth 1.5.6 has
	// no `requireLocalEmailVerified` gate, and there is no mail sender wired up,
	// so an unverified local account could be pre-registered at a victim's email
	// and a later Google sign-in would implicitly link into it. Do not re-enable
	// without first wiring email verification (sendVerificationEmail) and
	// requireEmailVerification.
	emailAndPassword: { enabled: false },
	account: {
		// Only Google is a trusted linking provider. A trusted provider bypasses
		// the incoming `emailVerified` check (better-auth 1.5.6 `link-account`
		// gate: `!isTrustedProvider && !userInfo.emailVerified`), so the set must
		// contain only IdPs that always assert a verified email. Google does;
		// GitHub does NOT (it can return an unverified primary email), so GitHub
		// is intentionally excluded even when enabled in create-auth.ts: an
		// untrusted GitHub identity only links to an existing same-email account
		// when GitHub itself reports the email verified. `email-password` is
		// absent because local credentials are disabled above.
		accountLinking: {
			enabled: true,
			trustedProviders: ['google'],
		},
	},
} satisfies BetterAuthOptions;
