# 0495. The Ark community profiles use at-handle paths

- **Status:** Proposed
- **Date:** 2026-10-03
- **Unbuilt:** community profile routing, handle allocation, stable profile identity, and profile links in mentions and following.

## Context

The Ark is intended as a writing and social home. Its community needs an address
for a writer that readers can recognize in bylines, mentions, and following.
A community profile and an independently presented publication are different
experiences, even when they expose the same author's work.

The address convention should express a person within The Ark without deciding
whether that person also publishes on an owned domain. Medium and Mastodon use
`/@username` profile paths, so this shape has existing social precedents.

## Decision

**The Ark's community profile address is `https://theark.so/@<handle>`.**
For example, Braden's community profile is `https://theark.so/@braden`.
Community bylines, mentions, search results, and following lists link to that
profile. The `@` marks the route as a person's handle and keeps profile routes
distinct from product routes such as `/settings`.

**A handle is a changeable name for a stable profile identity.** Authored work,
follows, and mentions attach to that stable identity rather than treating the
current handle or URL as their owner. Handle changes and old-link behavior need
an explicit policy before implementation.

**Custom domains and domain-based handles remain undecided.** This record does
not select `braden.theark.so`, bind `bradenwong.com` to a publication, or require
`@bradenwong.com` as a social handle. It also does not select essay URL shapes,
a federation protocol, or where private writing is edited and stored.

## Consequences

Readers enter a writer's profile within the shared community. The profile can
present authored work and social activity without requiring a personal website
or DNS configuration. The URL convention does not itself create social features.

The default address emphasizes membership in The Ark rather than an independent
publication. A future custom-domain publication may emphasize the writer's own
identity while remaining connected to the same community profile.

The `@` is a route convention, not domain verification or portable identity.
Those guarantees need their own mechanisms if the product adopts them.

## Considered alternatives

- `theark.so/braden`: workable, but does not visibly distinguish handles from
  other top-level product routes.
- `braden.theark.so`: better expresses a personal publication; it is not the
  default community profile selected here. Social features can work on either.
- Require a domain-based handle: introduces domain resolution and verification
  before portable identity has been chosen as a product requirement.

## References

- [Medium profile URL schemes](https://help.medium.com/hc/en-us/articles/115004746707-Your-profile-page-URL).
- [Mastodon profile URLs](https://docs.joinmastodon.org/user/profile/).
- [AT Protocol handles and stable identity](https://atproto.com/specs/handle).
