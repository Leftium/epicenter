/**
 * Epicenter self-hosted team Worker (reference implementation).
 *
 * Composes `@epicenter/server` with the `team({ isMember })` ownership rule
 * and ships zero billing surface. Workspace data is partitioned under the
 * literal `TEAM_OWNER_ID` ("team"); the membership predicate runs per request
 * against a deployment-owned email allowlist.
 *
 * This is a reference, not an Epicenter-operated product. Copy this folder,
 * fill in the deployment-owned secrets (Better Auth, OAuth provider keys,
 * AI provider keys, `ENCRYPTION_SECRETS`), provision your Cloudflare bindings
 * (Hyperdrive, R2, KV, Durable Objects), and deploy. Community-supported.
 *
 * Trust boundary: `ENCRYPTION_SECRETS` lives in the deployer's environment.
 * Epicenter never sees it, and therefore literally cannot decrypt workspace
 * data hosted on this deployment. Self-hosted is functionally zero-knowledge
 * against Epicenter.
 */

import {
	authApp,
	createServerApp,
	mountAiApp,
	mountAssetsApp,
	mountRoomsApp,
	mountSessionApp,
	requireBearerUser,
	Room,
	team,
} from '@epicenter/server';

const ownership = team({
	isMember: (c) => {
		const allowed = new Set(
			(c.env.ALLOWED_MEMBER_EMAILS ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean),
		);
		return allowed.has(c.var.user.email);
	},
});

const app = createServerApp();

app.get('/', (c) =>
	c.json({ mode: 'team', version: '0.1.0', runtime: 'cloudflare' }),
);

app.route('/', authApp);

mountSessionApp(app, { ownership });
mountRoomsApp(app, { ownership });
mountAssetsApp(app, { ownership });
mountAiApp(app, { auth: requireBearerUser });

export default app;
export { Room };
