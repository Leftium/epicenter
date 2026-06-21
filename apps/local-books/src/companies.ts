import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AppConfig } from './config.ts';
import { companiesFilePath } from './paths.ts';

/**
 * Tracks which QuickBooks companies (`realmId`s) have been authenticated, so
 * `sync` / `status` know which mirror to operate on without the user repeating
 * `--realm` every time. The keyring holds the tokens; this is just the index.
 */
export type Companies = { realms: string[]; defaultRealm: string | null };

export function readCompanies(dataDir: string): Companies {
	try {
		const parsed = JSON.parse(readFileSync(companiesFilePath(dataDir), 'utf8'));
		const realms = Array.isArray(parsed?.realms)
			? parsed.realms.filter((r: unknown) => typeof r === 'string')
			: [];
		const defaultRealm =
			typeof parsed?.defaultRealm === 'string' ? parsed.defaultRealm : null;
		return { realms, defaultRealm };
	} catch {
		return { realms: [], defaultRealm: null };
	}
}

/** Record a freshly-authenticated company and make it the default. */
export function recordCompany(dataDir: string, realmId: string): void {
	const current = readCompanies(dataDir);
	const realms = current.realms.includes(realmId)
		? current.realms
		: [...current.realms, realmId];
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		companiesFilePath(dataDir),
		JSON.stringify({ realms, defaultRealm: realmId }, null, 2),
	);
}

/**
 * Pick the company to act on: explicit `--realm`/env override, else the recorded
 * default, else the only authenticated company. Ambiguity is an error, not a
 * silent guess.
 */
export function resolveRealm(
	config: AppConfig,
): { realmId: string; error: null } | { realmId: null; error: string } {
	if (config.realmOverride)
		return { realmId: config.realmOverride, error: null };

	const { realms, defaultRealm } = readCompanies(config.dataDir);
	if (defaultRealm) return { realmId: defaultRealm, error: null };
	if (realms.length === 1) return { realmId: realms[0] as string, error: null };
	if (realms.length === 0) {
		return {
			realmId: null,
			error: 'No authenticated company. Run "local-books auth" first.',
		};
	}
	return {
		realmId: null,
		error: `Multiple companies authenticated (${realms.join(', ')}). Pass --realm <realmId>.`,
	};
}
