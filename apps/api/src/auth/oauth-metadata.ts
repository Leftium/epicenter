import { AUTH_BASE_PATH } from './base-config';

const AUTH_ISSUER_PATH = AUTH_BASE_PATH.replace(/\/+$/, '');
const AUTH_ISSUER_SEGMENT = AUTH_ISSUER_PATH.replace(/^\/+/, '');

export function createOAuthIssuerURL(baseURL: string) {
	return `${baseURL.replace(/\/+$/, '')}${AUTH_ISSUER_PATH}`;
}

export function createOAuthJwksURL(baseURL: string) {
	return `${createOAuthIssuerURL(baseURL)}/jwks`;
}

export const OAUTH_OPENID_CONFIGURATION_PATH = `${AUTH_ISSUER_PATH}/.well-known/openid-configuration`;
export const OAUTH_AUTHORIZATION_SERVER_METADATA_PATH = AUTH_ISSUER_SEGMENT
	? `/.well-known/oauth-authorization-server/${AUTH_ISSUER_SEGMENT}`
	: '/.well-known/oauth-authorization-server';
export const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
	'/.well-known/oauth-protected-resource';
export const OAUTH_METADATA_CACHE_CONTROL =
	'public, max-age=15, stale-while-revalidate=15, stale-if-error=86400';
