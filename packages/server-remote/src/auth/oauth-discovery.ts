import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import type { Auth } from 'better-auth';

/** Creates a handler for `GET /.well-known/openid-configuration/auth`. */
export function createOidcConfigHandler(auth: Auth) {
	return (c: { req: { raw: Request } }) =>
		oauthProviderOpenIdConfigMetadata(auth as never)(c.req.raw);
}

/** Creates a handler for `GET /.well-known/oauth-authorization-server/auth`. */
export function createOAuthMetadataHandler(auth: Auth) {
	return (c: { req: { raw: Request } }) =>
		oauthProviderAuthServerMetadata(auth as never)(c.req.raw);
}
