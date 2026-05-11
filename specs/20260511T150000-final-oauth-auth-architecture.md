# Final OAuth And Deployable Boundary Architecture

**Date**: 2026-05-11
**Status**: Draft, clean-break revision
**Author**: AI assisted
**Supersedes**:

- `specs/20260511T105846-auth-oauth-everywhere-clean-break.md`
- `specs/20260511T141800-accounts-origin-auth-server-clean-break.md`

## One Sentence

Epicenter Server is the self-hostable no-Postgres auth and sync runtime, Epicenter Cloud is the hosted Drizzle and Postgres control plane, and every Epicenter client uses OAuth access tokens for protected resources.

## Overview

This spec collapses Epicenter auth into one model for browser apps, extensions, Tauri apps, CLI tools, and daemon processes, then separates the deployable products by infrastructure requirement. Epicenter Server owns self-hostable auth, OAuth, identity, and sync without Postgres. Epicenter Cloud owns hosted-only control-plane features that need Drizzle, Postgres, billing, registry tables, and managed infrastructure.

The target is not "Better Auth everywhere." The target is narrower:

```txt
Epicenter Server:
  account cookies
  Better Auth raw User and Session records
  OAuth login and consent
  OAuth token issuance and revocation
  OAuth JWKS
  OAuth access-token verification
  AuthUser projection
  encryption-key derivation
  workspace and document sync

Epicenter Cloud:
  Drizzle and Postgres bindings
  billing
  hosted storage registry
  asset management
  dashboard and hosted control APIs

Epicenter clients:
  OAuthSession storage
  AuthIdentity state
  token refresh
  auth-owned fetch and WebSocket transport
```

## Better Auth Composition

One sentence:

```txt
Epicenter uses Better Auth as the auth server, OAuth as the app/resource protocol, and AuthIdentity as the Epicenter workspace boundary.
```

OAuth does not replace Better Auth. Better Auth still owns the hard generic auth
machinery: users, account sessions, account cookies, email and social login,
OAuth consent, OAuth token issuing, revocation, JWKS, and metadata. Epicenter
does not reimplement those pieces.

Epicenter composes Better Auth by making OAuth the only credential family that
leaves the server boundary.

```txt
Better Auth inside Epicenter Server:
  account login
  account cookies
  raw User and Session records
  oauthProvider authorize/token/revoke
  JWKS and issuer metadata

OAuth outside Epicenter Server:
  access tokens for protected resources
  refresh tokens in private app auth storage
  audience-bound resource calls
  WebSocket sync credentials

Epicenter-specific layer:
  /me
  AuthUser projection
  encryption key derivation
  AuthIdentity
  OAuthSession
  auth.fetch()
  auth.openWebSocket()
```

This is not the most direct Better Auth browser-cookie implementation. A normal
single-origin browser app can let Better Auth cookies be the whole runtime auth
story. Epicenter is not only a single-origin browser app. It has browser apps,
extensions, Tauri apps, CLI tools, daemon processes, local workspace boot, and
WebSocket sync. OAuth is the shared protocol across those runtimes.

The composition rule:

```txt
Use Better Auth for auth-server machinery.
Use OAuth for app-to-resource credentials.
Use Epicenter code only for Epicenter-specific identity and workspace keys.
```

The anti-rule:

```txt
Do not let Better Auth session tokens become app runtime credentials.
Do not make every client type invent a credential shape.
Do not put encryption keys in OAuth token claims.
```

## Why This Exists

The current worktree is halfway between two models.

```txt
Old model:
  apps sometimes use Better Auth cookies
  apps sometimes use Better Auth bearer session tokens
  /auth/oauth-session bridges OAuth tokens back into Better Auth session tokens
  set-auth-token rotates session credentials
  AuthSessionResponse names Better Auth session vocabulary

New model:
  apps use OAuth access and refresh tokens
  protected routes verify OAuth access tokens as resource-server requests
  /me returns AuthIdentity only
  AuthUser is small and stripped
```

The smell is not the date normalization helper anymore. That helper was a symptom. The deeper problem is mixed credential ownership and mixed deployable ownership. A first-party browser app, extension, Tauri app, CLI, and daemon should not each teach the auth package a different credential family. A self-hostable server should also not import the hosted cloud control plane just to sync a workspace.

## Non-Negotiable Invariants

```txt
Epicenter Server validates login credentials and owns account cookies.
Epicenter Server owns raw Better Auth User and Session records.
Epicenter Server issues OAuth tokens through oauthProvider.
Epicenter Server derives encryption keys from user id.
Epicenter Server owns workspace and document sync.
Epicenter Server has no Postgres dependency.
Epicenter Server has no Drizzle Postgres bindings.
Epicenter Cloud owns hosted control-plane state that requires Postgres.
AuthIdentity never contains credentials.
OAuthSession may contain OAuth credentials because it is private auth storage.
Better Auth session tokens never enter app auth storage.
set-auth-token is not an app runtime credential.
Workspace boot reads user id and encryption keys from AuthIdentity.
Protected resource calls use OAuth access tokens.
WebSocket sync uses OAuth access tokens.
Refresh failure pauses network auth, not local workspace access.
```

## Ownership Model

```txt
+--------------------------------------------------------------+
| apps/server                                                  |
|                                                              |
| Owns:                                                        |
|   Better Auth                                                |
|   sign-in pages                                              |
|   account cookies                                            |
|   consent and account-factor flows                           |
|   OAuth authorize, token, revoke, JWKS, metadata             |
|   /me                                                        |
|   workspace sync                                             |
|   document sync                                              |
|   self-hostable storage                                      |
|                                                              |
| Does not own:                                                |
|   Postgres                                                   |
|   billing                                                    |
|   hosted storage registry                                    |
|   cloud asset management                                     |
+--------------------------------------------------------------+
                         |
                         | OAuth access token
                         | aud = protected resource origin
                         v
+--------------------------------------------------------------+
| Epicenter apps                                               |
|                                                              |
| Owns:                                                        |
|   OAuthSession                                               |
|   local AuthIdentity                                         |
|   refresh-token persistence                                  |
|   auth.fetch and auth.openWebSocket                          |
|                                                              |
| Does not own:                                                |
|   Better Auth raw Session                                    |
|   Better Auth session token                                  |
|   hosted credential forms                                    |
+--------------------------------------------------------------+
                         |
                         | hosted control-plane calls
                         v
+--------------------------------------------------------------+
| apps/cloud                                                   |
|                                                              |
| Own:                                                         |
|   Drizzle and Postgres                                       |
|   billing                                                    |
|   hosted storage registry                                    |
|   asset management                                           |
|   dashboards                                                 |
|   hosted control APIs                                        |
|                                                              |
| Do not own:                                                  |
|   raw sign-in                                                |
|   account cookies                                            |
|   self-hostable sync runtime                                 |
+--------------------------------------------------------------+
```

## Boundary Correction

This spec began as a cleanup of path-based OAuth under `api.epicenter.so/auth`.
That cleanup first produced the `accounts.epicenter.so` plus `api.epicenter.so`
origin split:

```txt
accounts.epicenter.so
  OAuth issuer
  account cookies
  sign-in, consent, token, revoke, JWKS, discovery

api.epicenter.so
  OAuth protected resource
  /me
  workspace sync
  documents
  billing
  hosted storage controls
```

That split is better than the old path-based issuer because it makes the OAuth
roles visible. It is still not the final architecture because it answers the
hostname question, not the deployable-product question.

There are two separate axes:

```txt
OAuth origin axis:
  issuer
  protected resource

Deployable product axis:
  self-hostable server with no Postgres
  hosted cloud control plane with Drizzle and Postgres
```

Do not let the hostname axis choose the package boundary. The long-term
self-hosted product wants a small server that can run auth and sync without
Postgres. The hosted cloud product wants Drizzle, Postgres, billing, registry
tables, asset management, reconciliation jobs, and dashboard APIs.

The corrected product sentence:

```txt
Epicenter Server is the self-hostable auth and sync runtime; Epicenter Cloud is
the hosted control plane that uses Postgres and managed infrastructure.
```

### Naming Direction

Final app names:

```txt
apps/server
  self-hostable Hono server
  no Postgres dependency
  no Drizzle Postgres bindings
  auth, OAuth, /me, workspace sync, document sync

apps/cloud
  hosted Hono server
  Drizzle and Postgres allowed
  billing, registry, asset management, storage controls, hosted dashboards
```

Avoid naming the self-hostable runtime `accounts`. Account pages are only one
part of it. If sync lives there too, `accounts` becomes a lie.

Avoid naming the hosted control plane only `api`. `api` describes a transport
shape, not the product responsibility. `cloud` is the better boundary name
because it explains why Postgres, billing, and managed registry state are
allowed there.

### Domain Decision

Use two deployables and three hosted public domains.

Boundary rule:

```txt
Domains split by public protocol role.
Deployables split by infrastructure and operational boundary.
Hono modules split by code composition boundary.
```

Apply that rule whenever a route, package, or app boundary is unclear:

```txt
Domain:
  What URL does a client talk to?
  What OAuth role does this origin play?

Deployable:
  What can be built, configured, hosted, scaled, and released together?
  What infrastructure is allowed here?

Hono module:
  What routes belong together in code?
  What dependencies does this route group need?
```

```txt
accounts.epicenter.so
  served by apps/server
  OAuth issuer and account pages

sync.epicenter.so
  served by apps/server
  OAuth protected resource for /me, workspaces, and documents

api.epicenter.so
  served by apps/cloud
  hosted cloud control plane
```

Two deployables keep the code boundary clean:

```txt
apps/server
  no Postgres
  auth + sync

apps/cloud
  Postgres allowed
  hosted control plane
```

Three domains keep the public contract honest:

```txt
accounts.epicenter.so
  "sign in here"

sync.epicenter.so
  "sync data here"

api.epicenter.so
  "manage hosted cloud services here"
```

The repo boundary and the public domain boundary do not need to be identical.
One Hono app can serve multiple hostnames through host dispatch. That is not
technical debt when the dispatch follows public protocol roles and the
deployable still has one product responsibility.

Public domain tree:

```txt
epicenter.so
|-- accounts.epicenter.so
|   |-- /.well-known/openid-configuration
|   |-- /.well-known/oauth-authorization-server
|   |-- /oauth2/authorize
|   |-- /oauth2/token
|   |-- /oauth2/revoke
|   |-- /jwks
|   |-- /sign-in
|   |-- /consent
|   `-- /device
|
|-- sync.epicenter.so
|   |-- /.well-known/oauth-protected-resource
|   |-- /me
|   |-- /workspaces/*
|   `-- /documents/*
|
`-- api.epicenter.so
    |-- /.well-known/oauth-protected-resource
    |-- /dashboard/*
    |-- /api/billing/*
    |-- /api/storage/*
    `-- /api/assets/*
```

Hosted domain to deployable mapping:

```txt
accounts.epicenter.so
  -> apps/server
     -> account and OAuth routes

sync.epicenter.so
  -> apps/server
     -> identity and sync routes

api.epicenter.so
  -> apps/cloud
     -> dashboard and hosted control APIs
```

The implementation should still use mountable Hono modules inside those
deployables. A module boundary is useful for composition and tests. A deployable
boundary is only useful when the product, storage, scaling, or release cadence is
actually independent.

```txt
apps/server
|-- createAccountsRoutes()
|   |-- OAuth issuer metadata
|   |-- sign-in pages
|   |-- consent pages
|   |-- token, revoke, JWKS
|
|-- createSyncRoutes()
|   |-- protected-resource metadata
|   |-- /me
|   |-- workspace sync
|   `-- document sync
|
`-- createServerApp()
    |-- mounts accounts routes for accounts.epicenter.so
    `-- mounts sync routes for sync.epicenter.so

apps/cloud
|-- createCloudResourceRoutes()
|   |-- protected-resource metadata
|   |-- billing APIs
|   |-- hosted storage APIs
|   `-- asset APIs
|
|-- createDashboardRoutes()
|   `-- serves the dashboard SPA at /dashboard/*
|
`-- createCloudApp()
    `-- mounts cloud routes for api.epicenter.so
```

Composition happens at the app root, not inside the feature modules:

```txt
apps/server/src/app.ts
|-- createServerApp()
|   |-- createAccountsRoutes(serverEnv)
|   |-- createSyncRoutes(serverEnv)
|   `-- createHostDispatch({
|       |-- accounts.epicenter.so -> accountsRoutes
|       |-- sync.epicenter.so -> syncRoutes
|       `-- self-hosted default -> accountsRoutes + syncRoutes
|      })
|
`-- export default app

apps/cloud/src/app.ts
|-- createCloudApp()
|   |-- createCloudResourceRoutes(cloudEnv)
|   |-- createDashboardRoutes(cloudEnv)
|   `-- mount:
|       |-- /.well-known/oauth-protected-resource -> cloudResourceRoutes
|       |-- /api/* -> cloudResourceRoutes
|       `-- /dashboard/* -> dashboardRoutes
|
`-- export default app
```

The feature modules receive dependencies from the deployable root. They should
not import the deployable root or reach sideways into other modules.

```txt
apps/server/src/app.ts
  -> creates ServerEnv
  -> passes ServerEnv to createAccountsRoutes()
  -> passes ServerEnv to createSyncRoutes()

apps/cloud/src/app.ts
  -> creates CloudEnv
  -> passes CloudEnv to createCloudResourceRoutes()
  -> passes CloudEnv to createDashboardRoutes()
```

Server composition dependency tree:

```txt
ServerEnv
|-- auth
|   |-- Better Auth instance
|   |-- oauthProvider
|   `-- trusted clients
|-- identity
|   |-- user lookup
|   `-- encryption key derivation
|-- sync
|   |-- workspace store
|   |-- document store
|   `-- websocket rooms
`-- config
    |-- issuer origins
    |-- resource origins
    `-- self-hosted origin

createAccountsRoutes(ServerEnv)
  -> uses auth
  -> uses config
  -> does not use sync store

createSyncRoutes(ServerEnv)
  -> uses OAuth token verification
  -> uses identity
  -> uses sync
  -> does not issue account cookies
```

Cloud composition dependency tree:

```txt
CloudEnv
|-- oauth
|   |-- issuer = accounts.epicenter.so
|   `-- resource = api.epicenter.so
|-- db
|   |-- Drizzle
|   `-- Postgres
|-- billing
|-- storageRegistry
|-- assets
|-- dashboardAssets
`-- config
    `-- cloud origin

createCloudResourceRoutes(CloudEnv)
  -> verifies OAuth access tokens
  -> uses db, billing, storageRegistry, assets
  -> does not derive encryption keys

createDashboardRoutes(CloudEnv)
  -> serves built SvelteKit SPA
  -> does not own sign-in
  -> redirects to accounts OAuth when signed out
```

Two-deployable target tree:

```txt
apps/
|-- server/
|   |-- src/app.ts
|   |-- src/host-dispatch.ts
|   |-- src/modules/accounts.ts
|   |-- src/modules/sync.ts
|   |-- src/auth/
|   |-- src/identity/
|   |-- src/sync/
|   `-- src/storage/
|
`-- cloud/
    |-- src/app.ts
    |-- src/modules/cloud-resource.ts
    |-- src/modules/dashboard.ts
    |-- src/db/
    |-- src/billing/
    |-- src/assets/
    |-- src/storage-registry/
    `-- dashboard/
```

Future three-deployable split, only if accounts and sync become independently
operated products:

```txt
apps/
|-- accounts/
|   |-- src/app.ts
|   |-- src/auth/
|   |-- src/oauth/
|   `-- src/pages/
|
|-- sync/
|   |-- src/app.ts
|   |-- src/identity/
|   |-- src/workspaces/
|   |-- src/documents/
|   `-- src/rooms/
|
`-- cloud/
    |-- src/app.ts
    |-- src/modules/cloud-resource.ts
    |-- src/modules/dashboard.ts
    |-- src/db/
    |-- src/billing/
    `-- dashboard/
```

The module contracts should make that future split boring:

```txt
Today:
  apps/server/src/app.ts
    -> mounts createAccountsRoutes()
    -> mounts createSyncRoutes()

Future:
  apps/accounts/src/app.ts
    -> mounts createAccountsRoutes()

  apps/sync/src/app.ts
    -> mounts createSyncRoutes()
```

This is the compromise that keeps the architecture honest:

```txt
Use Hono route modules for:
  code organization
  testability
  host dispatch
  optional self-hosted composition

Use separate deployables for:
  different infrastructure requirements
  independent scaling needs
  separate ownership
  separate release cadence
```

Rejected alternatives:

```txt
Two domains only:
  accounts.epicenter.so + api.epicenter.so

Why rejected:
  sync has to live under accounts or cloud
  accounts-plus-sync makes the accounts name false
  cloud-plus-sync makes self-hosting depend on the hosted control plane

Three deployables:
  apps/accounts + apps/sync + apps/cloud

Why rejected:
  auth and sync are both required for the useful self-hosted server
  splitting them creates deployment overhead before there is an independent
  scaling or ownership need

Mountable modules inside two deployables:
  apps/server has accounts and sync route modules
  apps/cloud has cloud API and dashboard route modules

Why accepted:
  gives accounts, sync, cloud, and dashboard clear code boundaries
  avoids adding deployables before the runtime boundary needs them
  lets self-hosters run one server origin while hosted production uses
  role-specific domains
```

### Endpoint Shape

Self-hosted single-origin shape:

```txt
https://server.example.com

OAuth and account:
  /.well-known/openid-configuration
  /.well-known/oauth-authorization-server
  /.well-known/oauth-protected-resource
  /oauth2/authorize
  /oauth2/token
  /oauth2/revoke
  /jwks
  /sign-in
  /consent
  /device

Identity:
  /me

Sync resources:
  /workspaces/*
  /documents/*
```

Hosted clean-break shape:

```txt
https://accounts.epicenter.so

  /.well-known/openid-configuration
  /.well-known/oauth-authorization-server
  /oauth2/authorize
  /oauth2/token
  /oauth2/revoke
  /jwks
  /sign-in
  /consent
  /device

https://sync.epicenter.so

  /.well-known/oauth-protected-resource
  /me
  /workspaces/*
  /documents/*

https://api.epicenter.so

  /.well-known/oauth-protected-resource
  /api/storage/*
  /api/assets/*
  /api/billing/*
  /dashboard/*
```

The `accounts` and `sync` hosts are both backed by `apps/server` in hosted
production. Self-hosters run the same app on one origin; that origin exposes
both issuer and protected-resource metadata.

Do not introduce `/.auth` as the public namespace. The standard discovery
namespace is `/.well-known/*`. Do not carry `/auth` aliases into the clean-break
target. In the target self-hosted server and hosted accounts origin, OAuth is
first-class:

```txt
Good target:
  /.well-known/openid-configuration
  /oauth2/token
  /jwks

Deleted old shape:
  /auth/.well-known/openid-configuration
  /auth/oauth2/token
  /auth/jwks
```

## Public Shapes

### AuthUser

`AuthUser` is the signed-in principal, not the account profile.

```ts
export const AuthUser = type({
	'+': 'delete',
	id: 'string',
	email: 'string',
	name: 'string',
});

export type AuthUser = typeof AuthUser.infer;
```

Keep out:

```txt
createdAt
updatedAt
emailVerified
image
raw Better Auth plugin fields
raw session fields
```

If apps need account/profile metadata later, add a separate endpoint and type:

```ts
export const AccountProfile = type({
	'+': 'delete',
	userId: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
	createdAt: 'string',
	updatedAt: 'string',
});
```

That endpoint is not part of workspace boot. It must not become a back door for session metadata.

### AuthIdentity

`AuthIdentity` is the local-first identity needed to open a workspace.

```ts
export const AuthIdentity = type({
	'+': 'delete',
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});

export type AuthIdentity = typeof AuthIdentity.infer;
```

The only stable public meaning is:

```txt
AuthIdentity = who the local workspace belongs to + keys needed to decrypt it
```

### OAuthTokenGrant

`OAuthTokenGrant` is the parsed token result returned by the OAuth client layer after authorization-code or refresh-token exchange.

```ts
export const OAuthTokenGrant = type({
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});

export type OAuthTokenGrant = typeof OAuthTokenGrant.infer;
```

The parser should validate `token_type` and `expires_in`, then discard fields auth does not use.

```ts
function parseTokenGrant(response: oauth.TokenEndpointResponse): Result<OAuthTokenGrant, OAuthClientError> {
	if (response.token_type.toLowerCase() !== 'bearer') {
		return OAuthClientError.UnsupportedTokenType({ tokenType: response.token_type });
	}

	return Ok(OAuthTokenGrant.assert({
		accessToken: readString(response, 'access_token'),
		refreshToken: readString(response, 'refresh_token'),
		accessTokenExpiresAt: now() + readPositiveNumber(response, 'expires_in') * 1000,
	}));
}
```

Do not persist `scope` or `tokenType`. They are parse-time validation details.

### OAuthSession

`OAuthSession` is private app auth storage. It combines local identity and OAuth credentials because cached identity lets local-first apps boot offline.

```ts
export const OAuthSession = type({
	'...': AuthIdentity,
	'+': 'delete',
	accessToken: 'string',
	refreshToken: 'string',
	accessTokenExpiresAt: 'number',
});

export type OAuthSession = typeof OAuthSession.infer;
```

Expanded:

```ts
type OAuthSession = {
	user: AuthUser;
	encryptionKeys: EncryptionKeys;
	accessToken: string;
	refreshToken: string;
	accessTokenExpiresAt: number;
};
```

This is allowed to contain OAuth credentials because it is stored behind the auth package boundary. It is not a UI type and not a workspace document type.

### AuthState

```ts
type AuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in'; identity: AuthIdentity }
	| { status: 'reauth-required'; identity: AuthIdentity };
```

`reauth-required` means:

```txt
The app still has a cached identity for local data, but network auth is paused.
```

It should not mean:

```txt
The access token expiry timestamp is in the past.
```

Expired access tokens are a transport freshness issue. Refresh failure is the state transition.

### OAuthTransaction

The PKCE transaction is temporary launcher state, not an auth session.

```ts
export const OAuthTransaction = type({
	'+': 'delete',
	state: 'string',
	codeVerifier: 'string',
	redirectUri: 'string',
	issuer: 'string',
	resource: 'string',
	clientId: 'string',
	returnTo: 'string | null',
	createdAt: 'number',
});
```

Store this in session-like temporary storage. Remove it after callback handling. Do not reuse `OAuthSessionStorage` for it.

## Server Routes

### Epicenter Server

```txt
self-hosted:
  https://server.example.com

hosted:
  https://accounts.epicenter.so
  https://sync.epicenter.so

/.well-known/openid-configuration
/.well-known/oauth-authorization-server
/.well-known/oauth-protected-resource
/oauth2/authorize
/oauth2/token
/oauth2/revoke
/jwks
/sign-in
/consent
/device
/me
/workspaces/*
/documents/*
/*
```

The Better Auth catch-all belongs only after first-party pages, metadata routes,
identity routes, and sync routes that must be owned by Epicenter code.

Better Auth plugins in the final server app:

```txt
Keep:
  oauthProvider
  jwt
  email/password and social providers

Remove from the final app path:
  bearer
  customSession
  deviceAuthorization
```

The important Better Auth source detail: `deviceAuthorization` returns a Better Auth session token as `access_token` and does not return `refresh_token`. That token is not an oauthProvider resource access token. It must not be stored as `OAuthSession`.

### Epicenter Cloud

```txt
https://api.epicenter.so

/.well-known/oauth-protected-resource
/api/assets/*
/api/billing/*
/api/storage/*
/dashboard/*
```

Cloud is an OAuth protected resource, but it is not the primary identity or
sync runtime. It verifies access tokens issued by Epicenter Server and serves
hosted-only control-plane APIs.

`/me` exists on Epicenter Server. Do not add `/auth/me`, and do not put
workspace boot identity on Cloud.

Dashboard lives under Cloud:

```txt
https://api.epicenter.so/dashboard/*
  served by apps/cloud
  implemented as a reactive SvelteKit SPA
  built with adapter-static or equivalent static output
  mounted by the Cloud Hono app as dashboard assets and fallback routes
```

The dashboard is allowed to use `packages/ui` and normal Svelte client-side
patterns. It is not allowed to become the account authority. It signs in through
`accounts.epicenter.so`, receives an OAuth token for `api.epicenter.so`, and
calls Cloud APIs with that token.

```txt
Dashboard sign-in:

api.epicenter.so/dashboard
  -> redirects to accounts.epicenter.so/oauth2/authorize
  -> accounts uses Better Auth cookie to complete login and consent
  -> accounts redirects back with OAuth code
  -> dashboard exchanges code at accounts.epicenter.so/oauth2/token
  -> token audience is api.epicenter.so
  -> dashboard calls api.epicenter.so/api/*
```

Pricing and hosted subscription state belong to Cloud:

```txt
apps/cloud
|-- dashboard pricing pages
|-- checkout and subscription screens
|-- plan and entitlement APIs
|-- usage and invoice surfaces
|-- billing provider integration
`-- Postgres-backed hosted account metadata
```

`apps/server` may show account settings that are required for sign-in, recovery,
MFA, passkeys, consent, and self-hosted account administration. It must not need
pricing tables, billing provider SDKs, hosted plan state, or cloud registry
tables to boot.

Cloud dependency tree:

```txt
apps/cloud
|-- depends on:
|   |-- packages/ui
|   |-- packages/auth shared types
|   |-- OAuth access-token verification
|   |-- Drizzle
|   |-- Postgres
|   |-- billing provider SDKs
|   |-- hosted storage registry
|   `-- asset management
|
`-- must not depend on:
    |-- Better Auth raw Session as app auth
    |-- Better Auth getSession() for protected resources
    |-- encryption key derivation
    |-- apps/server sync internals
    `-- /me as workspace boot identity
```

Server dependency tree:

```txt
apps/server
|-- depends on:
|   |-- Better Auth
|   |-- oauthProvider
|   |-- OAuth token issuing and JWKS
|   |-- self-hostable storage
|   |-- workspace sync
|   |-- document sync
|   |-- encryption key derivation
|   `-- packages/auth shared types
|
`-- must not depend on:
    |-- Drizzle Postgres bindings
    |-- billing provider SDKs
    |-- hosted storage registry
    |-- cloud dashboard source
    `-- proprietary cloud-only control-plane code
```

`/me` flow:

```txt
1. Read Authorization: Bearer <access token>.
2. Verify token with issuer and audience for the server resource.
3. Read payload.sub.
4. Load Better Auth user row by id.
5. Project AuthUser with AuthUser.assert(row).
6. Derive encryption keys from user.id.
7. Return AuthIdentity.
```

Protected resource middleware:

```txt
1. Verify OAuth access token.
2. Load user row by payload.sub.
3. Set c.var.user = AuthUser.assert(row).
4. Do not derive encryption keys.
5. Do not call Better Auth getSession().
```

Only `/me` should derive encryption keys. Billing routes, assets, storage
controls, documents, and workspace sync need the user principal, not encryption
keys.

## Client Flows

### Browser Apps

```txt
App route:
  createOAuthAppAuth({ issuer, resource, clientId, launcher, sessionStorage })

Sign-in:
	auth.startSignIn({ returnTo })
	  -> launcher creates PKCE transaction
	  -> browser navigates to accounts /oauth2/authorize
	  -> accounts uses Better Auth cookie to complete login and consent
	  -> accounts redirects back with code
	  -> launcher exchanges code for OAuthTokenGrant
	  -> auth calls GET resource /me
	  -> auth stores OAuthSession
```

Browser apps do not use Better Auth cookies as app runtime auth, even if served from `api.epicenter.so/dashboard`.

Workspace apps request a token for the sync resource, not the cloud resource:

```txt
Workspace app sign-in:

workspace app
  -> redirects to accounts.epicenter.so/oauth2/authorize
  -> includes resource = https://sync.epicenter.so
  -> accounts completes sign-in and consent
  -> workspace app exchanges code at accounts.epicenter.so/oauth2/token
  -> token audience is sync.epicenter.so
  -> workspace app calls sync.epicenter.so/me
  -> /me returns AuthIdentity with encryption keys
  -> workspace app opens sync.epicenter.so/workspaces/*
```

Workspace sync runtime:

```txt
workspace app
|-- OAuthSession
|   |-- AuthIdentity
|   |   |-- AuthUser
|   |   `-- encryptionKeys
|   |-- accessToken for sync.epicenter.so
|   |-- refreshToken issued by accounts.epicenter.so
|   `-- accessTokenExpiresAt
|
|-- auth.fetch()
|   `-- adds Authorization: Bearer <sync access token>
|
`-- auth.openWebSocket()
    |-- refreshes token if needed
    |-- opens sync.epicenter.so/workspaces/*
    `-- sends OAuth access token to the sync resource
```

A workspace app that also needs hosted billing or dashboard data must request a
separate Cloud grant:

```txt
sync token:
  issuer = accounts.epicenter.so
  resource = sync.epicenter.so
  used for /me, workspaces, documents

cloud token:
  issuer = accounts.epicenter.so
  resource = api.epicenter.so
  used for billing, storage registry, assets, dashboard APIs
```

Do not reuse a token across resource audiences.

### Extensions

```txt
Extension:
  browser.identity.launchWebAuthFlow
  PKCE transaction in extension session storage
  token exchange through oauth4webapi
  same OAuthTokenGrant as browser apps
  same GET /me identity load
```

### Tauri Apps

```txt
Tauri:
  preferred: system browser + loopback callback or deep link
  same OAuth authorization-code with PKCE
  same OAuthTokenGrant
  same OAuthSession
```

Do not add Tauri-only token shapes. The launcher can differ. The persisted auth session cannot.

### CLI And Daemons

The final machine auth path must also produce OAuthTokenGrant.

Preferred first implementation:

```txt
CLI:
  open system browser
  listen on 127.0.0.1 callback port
  authorization-code with PKCE
  token exchange returns access_token, refresh_token, expires_in
  store OAuthSession in keychain
```

Deferred headless implementation:

```txt
OAuth device grant:
  accounts issues user_code and device_code
  user approves on accounts origin
  token endpoint returns OAuth access and refresh tokens
```

Do not use Better Auth `deviceAuthorization` as the final machine flow. Its current token is a Better Auth session token, which breaks the OAuth-everywhere invariant.

## Auth Client API

This is the local-first app auth client for Epicenter Server resources. It
loads `AuthIdentity`, including encryption keys, from the configured resource's
`/me` endpoint. Cloud-control surfaces that only need hosted account and billing
state should use a narrower Cloud OAuth client that stores an OAuth grant and
projects `AuthUser`, not workspace keys.

```ts
export type CreateOAuthAppAuthConfig = {
	issuer: string;
	resource: string;
	clientId: string;
	sessionStorage: OAuthSessionStorage;
	launcher: OAuthSignInLauncher;
	fetch?: typeof fetch;
	WebSocket?: typeof WebSocket;
	refreshOAuthToken?: OAuthTokenRefresher;
	revokeOAuthRefreshToken?: OAuthRefreshTokenRevoker;
	now?: () => number;
};
```

`baseURL` should split into `issuer` and `resource`.

```txt
issuer:
  OAuth authorization server
  accounts.epicenter.so

resource:
  OAuth audience and protected resource base URL
  sync.epicenter.so for workspace apps
```

One `OAuthSession` belongs to one resource audience. A client that needs both
sync and cloud APIs must request explicit grants for both resources. Do not
silently reuse a `sync.epicenter.so` token against `api.epicenter.so`, or an
`api.epicenter.so` token against `sync.epicenter.so`.

The public client stays capability-based:

```ts
type AuthClient = {
	readonly state: AuthState;
	onStateChange(fn: (state: AuthState) => void): () => void;
	startSignIn(input?: { returnTo?: string }): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	[Symbol.dispose](): void;
};
```

No public fields:

```txt
bearerToken
accessToken
refreshToken
session
expiresAt
```

## Validation Boundaries

Use ArkType at durable and network boundaries:

```txt
Better Auth user row -> AuthUser.assert(row)
GET /me response -> AuthIdentity.assert(json)
token grant parser -> OAuthTokenGrant.assert(parsed)
storage load -> OAuthSession.assert(JSON.parse(raw))
storage save -> OAuthSession.assert(value)
```

Use `'+': 'delete'` on exported storage and API shapes. This keeps the contract honest even when Better Auth rows carry extra fields.

Avoid helper names that imply old ownership:

```txt
Delete:
  authUserFromBetterAuthUser
  AuthSessionResponse
  BetterAuthSessionResponse
  oauthSessionFromAuthSessionResponse
  authIdentityFromAuthSessionResponse

Keep or create:
  createAuthIdentityResponse
  resolveOAuthPrincipal
  parseTokenGrant
  identityFromSession
```

`createAuthIdentityResponse` belongs on the Epicenter Server side because it derives encryption keys. It should be used by `/me`, not by Better Auth `customSession` in the final system.

## Asymmetric Refusals

### Refuse Cookie App Auth

Product sentence:

```txt
Apps authenticate with OAuth and call protected resources with OAuth access tokens.
```

Behavior refused:

```txt
Dashboard or same-site browser apps may use Better Auth cookies directly.
```

Code family deleted:

```txt
createCookieAuth
cookie platform auth modes
cookie resource middleware branch
app credential forms
Better Auth getSession for protected resources
```

User loss:

```txt
Browser apps store OAuth tokens in app storage. This is not as strong as HttpOnly cookie-only auth against XSS, but Epicenter apps already hold local workspace data and encryption keys in the same runtime. XSS is already a serious compromise.
```

Decision:

```txt
Refuse it. One app auth model is worth more than a cookie shortcut for first-party browser apps.
```

### Refuse Better Auth Session Tokens For Apps

Behavior refused:

```txt
Apps may exchange OAuth access tokens for Better Auth session tokens.
```

Code family deleted:

```txt
/auth/oauth-session
set-auth-token app handling
bearer plugin as app credential
Better Auth session-token storage
machine auth pretending Better Auth device tokens are OAuthSession
```

Decision:

```txt
Refuse it. Better Auth session tokens stay inside Epicenter Server. OAuth resource access tokens are the only app runtime credential.
```

### Refuse Account Profile In AuthIdentity

Behavior refused:

```txt
AuthIdentity includes account metadata because the user table has it.
```

Code family deleted:

```txt
date normalization
profile equality noise
storage churn on profile-only updates
confusion between account management and workspace boot
```

Decision:

```txt
Refuse it. AuthIdentity is for local workspace ownership, not account profile UI.
```

## Clean-Break Implementation Plan

Order matters. Build the new surfaces directly, move callers to them, then
delete the old surfaces. Do not add compatibility aliases to the target design.

### Wave 1: Freeze The Shared Types

- [ ] **1.1** Keep `AuthUser` as `{ id, email, name }` with `'+': 'delete'`.
- [ ] **1.2** Keep `AuthIdentity` as `{ user, encryptionKeys }` with `'+': 'delete'`.
- [ ] **1.3** Add `OAuthTokenGrant` and remove persisted `scope` and `tokenType` from auth core.
- [ ] **1.4** Keep `OAuthSession` as `AuthIdentity + accessToken + refreshToken + accessTokenExpiresAt`.
- [ ] **1.5** Ensure storage load and save assert `OAuthSession`.
- [ ] **1.6** Ensure token parser validates `token_type` before discarding it.

Verification:

```txt
bun test packages/auth/src
bun run typecheck in packages/auth
```

### Wave 2: Split Issuer And Resource In Client Config

- [ ] **2.1** Change `CreateOAuthAppAuthConfig.baseURL` to `issuer` and `resource`.
- [ ] **2.2** Change refresh-token requests to call `${issuer}/oauth2/token` with `resource`.
- [ ] **2.3** Change revoke requests to call `${issuer}/oauth2/revoke`.
- [ ] **2.4** Change identity loading to call `${resource}/me`.
- [ ] **2.5** Update OAuth launchers to discover from `issuer` and request `resource`.
- [ ] **2.6** Delete `createBrowserOAuthLauncherFromApi`.

Verification:

```txt
bun test packages/oauth-client/src
bun test packages/auth/src
```

### Wave 3: Create Apps Server

- [ ] **3.1** Create `apps/server` as a Hono app.
- [ ] **3.2** Move Better Auth construction, sign-in pages, consent pages, OAuth metadata, JWKS, `/me`, workspace sync, and document sync to `apps/server`.
- [ ] **3.3** Configure Better Auth with root OAuth paths.
- [ ] **3.4** Keep `oauthProvider`, `jwt`, and configured login providers.
- [ ] **3.5** Do not include `customSession`, `bearer`, or Better Auth `deviceAuthorization` in the final server path.
- [ ] **3.6** Enforce the no-Postgres boundary with package dependencies and tests.
- [ ] **3.7** Serve `accounts.epicenter.so` and `sync.epicenter.so` from this app in hosted production.
- [ ] **3.8** Keep accounts and sync as mountable Hono route modules inside `apps/server`.

Verification:

```txt
bun test apps/server/src
bun run typecheck in apps/server
manual smoke: accounts sign-in page renders
manual smoke: accounts OAuth discovery returns issuer accounts.epicenter.so
manual smoke: sync protected-resource discovery returns resource sync.epicenter.so
```

### Wave 4: Create Apps Cloud

- [ ] **4.1** Create `apps/cloud` as a Hono app.
- [ ] **4.2** Move Drizzle, Postgres schema, billing, assets, hosted storage registry, dashboards, and cloud control APIs to `apps/cloud`.
- [ ] **4.3** Verify access tokens with issuer `accounts.epicenter.so` and audience `api.epicenter.so`.
- [ ] **4.4** Add `resolveOAuthPrincipal` for cloud protected routes.
- [ ] **4.5** Make cloud middleware return `AuthUser`, not `AuthIdentity`.
- [ ] **4.6** Do not derive encryption keys in Cloud.
- [ ] **4.7** Do not call Better Auth `getSession()` in Cloud.
- [ ] **4.8** Build the dashboard as a SvelteKit SPA under `apps/cloud/dashboard`.
- [ ] **4.9** Serve the dashboard SPA from `api.epicenter.so/dashboard/*` through the Cloud Hono app.

Verification:

```txt
bun test apps/cloud/src
bun run typecheck in apps/cloud
bun run typecheck in apps/cloud/dashboard
```

### Wave 5: Move First-Party Apps To OAuth Everywhere

- [ ] **5.1** Configure dashboard with a Cloud OAuth client using `issuer = accounts.epicenter.so` and `resource = api.epicenter.so`.
- [ ] **5.2** Configure workspace SvelteKit apps with `issuer = accounts.epicenter.so` and `resource = sync.epicenter.so`.
- [ ] **5.3** Configure WXT extension launchers with `issuer = accounts.epicenter.so` and `resource = sync.epicenter.so`.
- [ ] **5.4** Remove app credential forms that duplicate hosted sign-in.
- [ ] **5.5** Replace sync bearer-token getters with `auth.openWebSocket`.
- [ ] **5.6** Replace direct fetch with `auth.fetch` for protected resources.
- [ ] **5.7** Use `sync.epicenter.so` as the hosted sync resource for workspace and document sync.
- [ ] **5.8** Add explicit separate grants when one app needs both sync and Cloud resources.

Verification:

```txt
bun run typecheck in each touched app
app smoke: sign in, refresh page, load workspace, sync
extension smoke: sign in, refresh side panel, sync
```

### Wave 6: Fix Machine Auth Honestly

- [ ] **6.1** Stop treating Better Auth device `access_token` as OAuthSession.
- [ ] **6.2** Implement CLI loopback PKCE sign-in against Epicenter Server.
- [ ] **6.3** Store the resulting OAuthSession in keychain.
- [ ] **6.4** Make daemon auth reuse the same OAuthSession refresh path as apps.
- [ ] **6.5** Do not ship headless device flow until it issues oauthProvider access and refresh tokens.

Verification:

```txt
bun test packages/auth/src/node
CLI smoke: login, status, protected fetch, logout
daemon smoke: starts with saved OAuthSession and syncs
```

### Wave 7: Delete Old Paths

- [ ] **7.1** No live code imports `@epicenter/auth/contracts`.
- [ ] **7.2** No live code calls `/auth/oauth-session`.
- [ ] **7.3** No app live code reads `set-auth-token`.
- [ ] **7.4** No protected route calls Better Auth `getSession()`.
- [ ] **7.5** No app exposes or consumes `auth.bearerToken`.
- [ ] **7.6** No app runtime imports `createCookieAuth` or `createBearerAuth`.
- [ ] **7.7** Delete `/auth/oauth-session` implementation and tests.
- [ ] **7.8** Delete contract modules that name `AuthSessionResponse`.
- [ ] **7.9** Delete Better Auth bearer app-session handling.
- [ ] **7.10** Delete `customSession` enrichment.
- [ ] **7.11** Remove `set-auth-token` from CORS exposure.
- [ ] **7.12** Delete old platform auth mode files.
- [ ] **7.13** Update docs and specs that describe the bridge model.

Verification:

```txt
rg "@epicenter/auth/contracts|/auth/oauth-session|set-auth-token|auth\\.bearerToken|createCookieAuth|createBearerAuth|getSession" apps packages
```

The grep may still find specs and historical docs. Live code should be clean.

Verification:

```txt
bun test packages/auth/src
bun test packages/oauth-client/src
bun test apps/server/src
bun test apps/cloud/src
bun run typecheck in packages/auth
bun run typecheck in apps/server
bun run typecheck in apps/cloud
targeted app typechecks
```

## Current Tree Versus Target Tree

Current auth-heavy tree:

```txt
apps/api/src/
|-- app.ts
|-- auth/
|   |-- create-auth.ts
|   |-- identity-response.ts
|   |-- me.ts
|   |-- oauth-metadata.ts
|   |-- oauth-resource.ts
|   |-- single-credential.ts
|   `-- trusted-oauth-clients.ts
packages/auth/src/
|-- auth-types.ts
|-- create-oauth-app-auth.ts
|-- node/
|   `-- machine-auth.ts
packages/oauth-client/src/
`-- index.ts
```

Target deployable shape:

```txt
apps/server/src/
|-- app.ts
|-- host-dispatch.ts
|-- modules/
|   |-- accounts.ts
|   `-- sync.ts
|-- auth/
|   |-- create-auth.ts
|   |-- oauth-metadata.ts
|   |-- pages.tsx
|   `-- trusted-oauth-clients.ts
|-- identity/
|   |-- me.ts
|   `-- auth-identity.ts
|-- sync/
|   |-- workspace-routes.ts
|   |-- document-routes.ts
|   `-- rooms.ts
`-- storage/
    `-- local-store.ts

apps/cloud/src/
|-- app.ts
|-- oauth-resource.ts
|-- modules/
|   |-- cloud-resource.ts
|   `-- dashboard.ts
|-- db/
|   |-- schema.ts
|   `-- client.ts
|-- billing/
|-- assets/
|-- storage-registry/
|-- dashboards/
`-- hosted-resources/

apps/cloud/dashboard/
|-- src/
|   |-- routes/
|   |-- lib/
|   `-- app.html
|-- svelte.config.js
`-- package.json

packages/auth/src/
|-- auth-contract.ts
|-- auth-errors.ts
|-- auth-state-store.ts
|-- auth-types.ts
|-- create-oauth-app-auth.ts
|-- node/
|   |-- machine-auth.ts
|   `-- machine-session-store.ts

packages/oauth-client/src/
|-- browser.ts
|-- extension.ts
|-- loopback.ts
|-- oauth-client.ts
|-- token-grant.ts
`-- transaction.ts
```

This tree records the product boundary:

```txt
apps/server
  useful without Postgres

apps/cloud
  allowed to require Postgres
  owns the SvelteKit dashboard source
  serves the built SPA at /dashboard/*
```

Dependency direction:

```txt
packages/auth shared types
  ^                  ^
  |                  |
apps/server      apps/cloud
  |                  |
  |                  `-- dashboard SPA
  |
  `-- accounts and sync route modules

apps/cloud verifies tokens from apps/server.
apps/server does not import apps/cloud.
```

Path to domain ownership:

```txt
apps/server/src/modules/accounts.ts
  -> accounts.epicenter.so/*

apps/server/src/modules/sync.ts
  -> sync.epicenter.so/*

apps/cloud/src/modules/cloud-resource.ts
  -> api.epicenter.so/api/*
  -> api.epicenter.so/.well-known/oauth-protected-resource

apps/cloud/src/modules/dashboard.ts
  -> api.epicenter.so/dashboard/*
  -> serves apps/cloud/dashboard build output
```

## Resolved Questions

1. Rename toward `apps/server` and `apps/cloud` in the clean-break wave.
2. Hosted sync uses `sync.epicenter.so`, served by `apps/server`.
3. Hosted account pages use `accounts.epicenter.so`, served by `apps/server`.
4. Hosted cloud control APIs use `api.epicenter.so`, served by `apps/cloud`.
5. Account profile metadata that belongs to sign-in, recovery, MFA, passkeys, or self-hosted account settings lives in `apps/server`.
6. Hosted subscription, billing, and managed storage account metadata lives in `apps/cloud`.
7. Dashboard remains under `api.epicenter.so/dashboard` because it is a cloud-control UI.
8. CLI uses loopback PKCE at launch. Headless device flow waits until it can issue real OAuth access and refresh tokens.
9. `/auth/me` is not kept. The clean-break target exposes `/me` only.
10. Accounts, sync, cloud resources, and dashboard surfaces are Hono route modules before they are deployables.
11. The dashboard is a SvelteKit SPA owned by `apps/cloud` and served at `api.epicenter.so/dashboard/*`.

## Decisions Log

- Keep `AuthIdentity` as a distinct type from `OAuthSession`: the distinction names the credential boundary. Revisit only if no code ever needs identity without tokens.
- Keep `/me` on Epicenter Server: encryption keys belong to the self-hostable runtime, not token claims and not Cloud.
- Use two deployables and three hosted domains: `apps/server` serves `accounts.epicenter.so` and `sync.epicenter.so`; `apps/cloud` serves `api.epicenter.so`.
- Treat host dispatch inside `apps/server` as public-role dispatch, not a package boundary.
- Use mountable Hono route modules inside the deployables. Revisit separate deployables only when accounts and sync have independent scaling, storage, ownership, or release cadence.
- Prefer `apps/server` for the self-hostable no-Postgres auth and sync runtime.
- Prefer `apps/cloud` for the hosted Drizzle and Postgres control plane.
- Keep hosted pricing, subscription, invoices, usage, and managed storage controls in `apps/cloud`, not `apps/server`.
- Serve the dashboard as a reactive SvelteKit SPA from Cloud so it can use the existing Svelte UI stack without making account auth depend on Cloud.
- Do not add `/.auth` as a public namespace. Use standard `/.well-known/*` discovery and root OAuth endpoints in the target shape.
- Delete `/auth/*` target paths instead of carrying aliases.
- Defer headless OAuth device flow: Better Auth's device plugin currently issues Better Auth session tokens, not OAuth refreshable resource tokens. Revisit only when CLI usage proves loopback browser login is not enough.
