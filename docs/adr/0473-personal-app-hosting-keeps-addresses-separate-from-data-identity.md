# 0473. Personal app hosting keeps addresses separate from data identity

- **Status:** Proposed
- **Date:** 2026-09-30
- **Amends:** [ADR-0335](0335-a-person-is-an-origin-and-an-app-is-a-path-under-it.md) at the intended hosting suffix and the assumption that every app in a person's space has blanket trust. App paths remain; arbitrary executable apps need a separate isolation decision.
- **Amends:** [ADR-0246](0246-an-app-is-named-by-its-full-reverse-domain-id-everywhere-including-the-ones-epicenter-ships.md) at public hosted paths: readable slugs may resolve full app IDs; internal host routes, deep links, and on-disk IDs keep the full identifier.
- **Relates:** [Independent applications](0449-epicenter-connects-independent-applications-through-personal-data.md), [publisher identity](0460-vocab-and-whispering-are-braden-wongs-apps-built-on-epicenter.md), and [portable folder scopes](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md).
- **Unbuilt:** all personal bundle hosting, username allocation, certificates, custom-domain bindings, and authenticated cross-origin data access.

## Context

Epicenter's intended hosted experience gives each person a home containing
several apps. Opening Whispering and then Notes selects tools within that space.
It should not require a new hostname for each tool.

The desktop host already lists applications by ID and title in
`apps/epicenter/src/applications.ts` and serves their built assets through
`apps/epicenter/src/server.ts`. This supports separating the app list from app
files; it does not establish an implemented personal hosting service.

A publisher's public app home and a user's personal workspace have different
jobs. An app published by Braden can serve many people's data. A personal
hostname selects a space; it does not identify the visitor or grant access.

## Decision

**Epicenter's default personal address is `<handle>.epicenter.so`, and trusted
workspace apps use top-level paths beneath that address.**

| Address | Purpose |
| --- | --- |
| `braden.epicenter.so/` | Braden's home and app launcher |
| `braden.epicenter.so/whispering` | Whispering in Braden's space |
| `braden.epicenter.so/notes` | Notes in Braden's space |

The root belongs to the launcher. Apps may have internal routes beneath their
own paths, but another app is never mounted there. Platform routes such as
`/.well-known/` are reserved. App assets support their mount paths; service
workers must not control sibling apps or the launcher.

**App paths belong to one trusted workspace, not to an arbitrary-code hosting
service.** Paths share an origin and provide no security boundary between apps.
Independent publishers and person-authored executable apps need an explicit
trust and isolation design before running in that space. This record grants no
deployed bundle blanket access to a visitor's credentials.

**Addresses remain separate from software and data identity.** A handle, app
slug, or domain change must not rename stable account, application, or data
identifiers. Requests check access independently of the hostname. Publicly
serving an SPA does not publish its users' files.

Public app slugs resolve to full app IDs through the personal app list. Slugs
must be unique within that space; two apps named Notes need distinct slugs.
This is a mapping for addresses people read, not a rename of internal host
routes, deep links, or folder namespaces.

**Custom-domain addresses remain undecided.** Neither app subdomains such as
`whispering.bradenwong.com` nor workspace paths such as
`apps.bradenwong.com/whispering` are selected here. Publisher app homes,
personal runtime addresses, public writing domains, and domain-based social
handles need separate treatment.

The intended `epicenter.so` suffix requires a verified hosting and
authentication isolation design. This proposal revisits ADR-0335's required
separate registrable hosting domain; it does not claim that subdomains alone
protect vendor authentication from person-controlled code. Revisit the suffix
before launch if safe hosting requires a different serving domain.

## Consequences

Adding a trusted app adds a path and launcher entry rather than another personal
hostname, browser origin, or certificate. A deployed SPA build can serve many
personal spaces; a person's app list references software instead of copying it.
Apps may keep independent builds and release schedules while sharing an origin.

Apps in one space share browser storage boundaries, origin-scoped permissions,
and exposure to a compromised sibling. They still choose their data contracts
and resource lifetimes. Sharing an origin does not automatically connect their
data or require one application shell.

Switching a handle or domain changes the browser origin. Existing local-only
work does not follow automatically. Hosting must settle local-data preservation,
handle reservation and reuse, authenticated access, certificate provisioning,
and domain ownership checks before launch. These addresses describe a planned
experience, not an available service.

## Considered alternatives

- `whispering.braden.epicenter.so`: introduces a separate origin and deeper
  hostname per app without a required boundary in the trusted workspace.
  Independent executable apps may still need separate origins.
- `epicenter.so/braden/whispering`: places all personal spaces on one browser
  origin and presents the person as a route inside the vendor application.
- One canonical private runtime with personal addresses only for publishing:
  avoids per-person origin migrations, but gives up opening tools inside one's
  personal space.

## References

- [Browser origins and paths](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).
- [IndexedDB origin boundaries](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API).
- [Cloudflare Universal SSL hostname limits](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).
