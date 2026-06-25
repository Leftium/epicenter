import type { ParsedArgs } from '../cli.ts';
import { recordCompany } from '../companies.ts';
import { loadConfig } from '../config.ts';
import { runAuthorizationFlow } from '../oauth.ts';
import { createFileTokenStore } from '../token-store.ts';
import { formatRelative } from './context.ts';

/**
 * One-time interactive OAuth2: open the browser, capture the localhost callback,
 * exchange the code, and store the token set in the token store keyed by realmId.
 */
export async function runAuth(args: ParsedArgs): Promise<number> {
	// No `realm` override: `auth` connects whatever company the browser logs into
	// and takes the realmId from the OAuth callback, so `--realm` does not apply.
	const config = loadConfig({
		dataDir: args.dataDir,
		environment: args.environment,
	});

	if (!config.clientId || !config.clientSecret) {
		console.error(
			'Missing QuickBooks credentials. Set QB_CLIENT_ID and QB_CLIENT_SECRET\n' +
				'(or run via `infisical run --path=/apps/local-books`) from your Intuit\n' +
				'app (https://developer.intuit.com → your app → Keys & credentials).',
		);
		return 1;
	}

	const store = createFileTokenStore(config.credentialsPath);

	console.error(`Authenticating against QuickBooks (${config.environment})...`);
	const { data: token, error } = await runAuthorizationFlow(config, {
		now: () => Date.now(),
		log: (m) => console.error(m),
	});
	if (error) {
		console.error(`auth failed: ${error.message}`);
		return 1;
	}

	await store.set(token);
	recordCompany(config.dataDir, token.realmId);

	const now = Date.now();
	console.log(`Connected company ${token.realmId} (${config.environment}).`);
	console.log(
		`Access token valid ${formatRelative(token.accessTokenExpiresAt, now)}.`,
	);
	console.log(
		`Refresh token valid ${formatRelative(token.refreshTokenExpiresAt, now)}.`,
	);
	console.log(`Tokens stored in ${config.credentialsPath}.`);
	console.log(`Next: "local-books sync --full" to seed the mirror.`);
	return 0;
}
