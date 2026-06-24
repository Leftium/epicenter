# 0058. Auth owns the `/api/session` endpoint; the data client is owner-scoped

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

`/api/session` returns `{ user, ownerId }`. The auth client already fetched it
(on sign-in and on every bearer verification) but discarded the profile,
publishing only `ownerId` on `state`. Meanwhile `@epicenter/client` fetched
`/api/session` a *second* time, lazily, just to learn the `ownerId` it needed to
build owner-scoped URLs, and the account popover fetched it a *third* time to
show the user's email. Two redundant reads, and the data client carried a
`session.*` surface plus a one-shot cache and `ready()` whose only job was to
resolve an identity the data client does not own. A clean break wanted exactly
one owner of identity.

## Decision

Auth owns `/api/session`. `auth.state` carries the capability id (`ownerId`);
`auth.getProfile()` reads presentational identity (the email) on demand through
the same credential boundary as `auth.fetch`. The data client receives `ownerId`
at construction, is owner-scoped, never touches `/api/session`, and exposes only
data surfaces (`blobs`, and the retiring `assets`). The email is never persisted
and never placed on `state`: that keeps `AuthState` (MIT, shared with workspace)
free of AGPL profile types and honors the standing rule that presentational
profile is fetched where it is displayed, not carried in capability/boot state.

## Consequences

- One identity owner. The data client is synchronous to construct, holds no
  session cache, and drops `ready()` and the entire `session.*` surface.
- The CLI reads `ownerId` off `auth.state` (failing closed when signed out); the
  account popover reads the email via `auth.getProfile()`, bridged into TanStack
  Query's throw-on-error contract with `queryOptions`. `app-shell` no longer
  depends on `@epicenter/client`.
- A profile read is now an explicit `getProfile()` call rather than a field on
  `state`. The displayed email can be momentarily stale until the next read,
  which is acceptable for a label and self-heals on the auth client's own
  `/api/session` revalidation; the capability `ownerId` is always fresh on
  `state`. This forecloses reading the email synchronously off `state`.

## Considered alternatives

- **Put `user` on `AuthState`.** Rejected: crosses the MIT/AGPL license firewall
  (`AuthState` lives in `@epicenter/identity`, `AuthUser` in `@epicenter/auth`)
  and contradicts the deliberate "capability state, not credential state" and
  "profile fetched on demand" design recorded on `AuthState`/`PersistedAuth`.
- **Keep `client.session.*` Result-native and bridge it in the popover.**
  Rejected: preserves a redundant `/api/session` read and leaves the data client
  owning an identity surface it should not have.
