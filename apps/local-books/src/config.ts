import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ENTITIES, isKnownEntity } from './entities.ts';
import { resolveDataDir } from './paths.ts';
import type { QbEnvironment } from './tokens.ts';

/**
 * Fully-resolved runtime configuration. Precedence is CLI flags > environment >
 * `<data-dir>/config.json` > built-in defaults. Base-URL fields are overridable
 * so tests can point the client at a mock QuickBooks server.
 */
export type AppConfig = {
	dataDir: string;
	environment: QbEnvironment;
	clientId: string | null;
	clientSecret: string | null;
	redirectUri: string;
	scopes: string[];
	entities: string[];
	/** QuickBooks data API origin, e.g. `https://sandbox-quickbooks.api.intuit.com`. */
	apiBase: string;
	/** OAuth2 token endpoint (authorization-code and refresh exchanges). */
	tokenUrl: string;
	/** OAuth2 authorization endpoint the browser is sent to. */
	authorizeUrl: string;
	minorVersion: string;
	/**
	 * Force a FULL pull once the stored cursor is older than this. Kept under the
	 * QuickBooks CDC 30-day lookback so incremental never silently loses a gap.
	 */
	cdcSafeWindowDays: number;
	/** Force a FULL pull this many days after the last one, as a correctness backstop. */
	fullBackstopDays: number;
	/** Query-API page size; QuickBooks caps results at 1000. */
	pageSize: number;
	keyringFile: string | null;
	realmOverride: string | null;
};

export type CliConfigOverrides = {
	dataDir?: string;
	environment?: QbEnvironment;
	realm?: string;
};

const API_BASE: Record<QbEnvironment, string> = {
	sandbox: 'https://sandbox-quickbooks.api.intuit.com',
	production: 'https://quickbooks.api.intuit.com',
};

const DEFAULT_TOKEN_URL =
	'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const DEFAULT_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const DEFAULT_REDIRECT_URI = 'http://localhost:8765/callback';
const DEFAULT_SCOPE = 'com.intuit.quickbooks.accounting';
const DEFAULT_MINOR_VERSION = '70';

type ConfigFile = {
	environment?: QbEnvironment;
	entities?: string[];
	redirectUri?: string;
	scopes?: string[];
	minorVersion?: string;
	cdcSafeWindowDays?: number;
	fullBackstopDays?: number;
	pageSize?: number;
};

function readConfigFile(dataDir: string): ConfigFile {
	try {
		const text = readFileSync(join(dataDir, 'config.json'), 'utf8');
		const parsed = JSON.parse(text);
		return typeof parsed === 'object' && parsed !== null ? parsed : {};
	} catch {
		// Missing/unreadable config.json is fine: it is optional.
		return {};
	}
}

function env(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

function resolveEntities(file: ConfigFile): string[] {
	const fromEnv = env('LOCAL_BOOKS_ENTITIES')
		?.split(',')
		.map((s) => s.trim());
	const requested = fromEnv ?? file.entities ?? DEFAULT_ENTITIES;
	const unknown = requested.filter((name) => !isKnownEntity(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown entities in config: ${unknown.join(', ')}. Known: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
	}
	return requested;
}

export function loadConfig(overrides: CliConfigOverrides = {}): AppConfig {
	const dataDir = resolveDataDir(overrides.dataDir);
	const file = readConfigFile(dataDir);

	const environment: QbEnvironment =
		overrides.environment ??
		(env('LOCAL_BOOKS_QB_ENV') as QbEnvironment | undefined) ??
		file.environment ??
		'sandbox';

	return {
		dataDir,
		environment,
		// Accept the bare QB_* names (what Infisical injects at /apps/local-books)
		// as well as the namespaced LOCAL_BOOKS_QB_* form.
		clientId: env('LOCAL_BOOKS_QB_CLIENT_ID') ?? env('QB_CLIENT_ID') ?? null,
		clientSecret:
			env('LOCAL_BOOKS_QB_CLIENT_SECRET') ?? env('QB_CLIENT_SECRET') ?? null,
		redirectUri:
			env('LOCAL_BOOKS_QB_REDIRECT_URI') ??
			file.redirectUri ??
			DEFAULT_REDIRECT_URI,
		scopes: file.scopes ?? [DEFAULT_SCOPE],
		entities: resolveEntities(file),
		apiBase: env('LOCAL_BOOKS_QB_API_BASE') ?? API_BASE[environment],
		tokenUrl: env('LOCAL_BOOKS_QB_TOKEN_URL') ?? DEFAULT_TOKEN_URL,
		authorizeUrl: env('LOCAL_BOOKS_QB_AUTHORIZE_URL') ?? DEFAULT_AUTHORIZE_URL,
		minorVersion:
			env('LOCAL_BOOKS_QB_MINOR_VERSION') ??
			file.minorVersion ??
			DEFAULT_MINOR_VERSION,
		cdcSafeWindowDays: file.cdcSafeWindowDays ?? 25,
		fullBackstopDays: file.fullBackstopDays ?? 7,
		pageSize: Math.min(file.pageSize ?? 1000, 1000),
		keyringFile: env('LOCAL_BOOKS_KEYRING_FILE') ?? null,
		realmOverride: overrides.realm ?? env('LOCAL_BOOKS_QB_REALM') ?? null,
	};
}
