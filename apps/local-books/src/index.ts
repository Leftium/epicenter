/**
 * Library surface for the local-books sync engine. The CLI (`bin.ts`) is the
 * primary entry point; these exports let tests and embedders drive the engine
 * directly.
 */
export type { AppConfig, CliConfigOverrides } from './config.ts';
export { loadConfig } from './config.ts';
export type { BooksDb, SyncStateRow } from './db.ts';
export { openBooksDb, SCHEMA_VERSION } from './db.ts';
export type { EntityDef } from './entities.ts';
export {
	DEFAULT_ENTITIES,
	ENTITY_DEFS,
	entityDef,
	isDeleted,
	isKnownEntity,
	lastUpdatedTime,
} from './entities.ts';
export type { Keyring } from './keyring.ts';
export {
	createFileKeyring,
	createKeyring,
	createMemoryKeyring,
} from './keyring.ts';
export type { OAuthDeps } from './oauth.ts';
export {
	exchangeAuthorizationCode,
	refreshAccessToken,
	runAuthorizationFlow,
} from './oauth.ts';
export type { QbClient } from './qb-client.ts';
export { createQbClient } from './qb-client.ts';
export type { SyncDeps, SyncEntityResult, SyncMode } from './sync.ts';
export { decideMode, syncAll, syncEntity } from './sync.ts';
export type { TokenManager } from './token-manager.ts';
export {
	createTokenManager,
	loadToken,
	storeToken,
} from './token-manager.ts';
export type { TokenSet } from './tokens.ts';
export {
	isAccessTokenExpired,
	isRefreshTokenExpired,
	tokenSetFromGrant,
} from './tokens.ts';
