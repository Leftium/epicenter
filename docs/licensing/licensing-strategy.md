# Licensing Strategy

**Status:** Active
**Date:** 2026-04-28
**Owner:** Braden Wong

## Summary

Epicenter uses two active license tiers. The embeddable toolkit libraries (`workspace`, `ui`, `filesystem`, `sync`, and their internal utilities) are MIT to maximize developer adoption. Everything else Epicenter ships, all apps and the internal/server packages, is AGPL-3.0. A third proprietary tier is documented as an escape hatch but deferred indefinitely; revenue comes from hosting, not licensing. There is no Contributor License Agreement; we do not dual-license.

This document is the canonical reference. The companion document [FINANCIAL_SUSTAINABILITY.md](../FINANCIAL_SUSTAINABILITY.md) is the public-facing narrative for why we made these choices. The root [LICENSE](../LICENSE) is the legal dispatch. This spec is the technical reasoning, threat model, and decision procedure for new packages.

## Operating principle

Every licensing decision is filtered through "does this stay sustainable for a single maintainer?" AGPL-everywhere on commercial-relevant code is the default because it is operationally cheap: no proprietary build pipelines, no commercial license sales process, no enterprise plugin gating, no CLA bot to maintain. Revenue is captured at the hosting layer (uptime, ops, backups, support, compliance), not the license layer.

The proprietary tier is preserved as an option for one specific situation: a paying customer requires a specific feature that AGPL self-hosting would otherwise give away free. It will not be populated speculatively. An empty proprietary tier is the correct end-state if hosting revenue scales, and is the model used by Plausible and PostHog.

AGPL on apps where self-host is practically fictional (because they require the full Epicenter cloud stack to run) is a deliberate choice. It trades enterprise-self-host upsell optionality for trust, brand consistency, and zero rug-pull risk. This is consistent with the local-first ethos: users can always read and fork the code, even if running it independently is hard.

## Threat model

The motivating concern is direct code copying by competitors. This is not theoretical: there is a steady drumbeat of stories in the local-first and developer-tools space of one team taking another team's open source code, rebranding it, and shipping it as a competing product, sometimes hosted, sometimes embedded inside a closed-source app.

We sort this into four scenarios:

| # | Scenario | MIT outcome | AGPL outcome | Proprietary outcome |
|---|---|---|---|---|
| 1 | An individual runs Epicenter locally for personal use | Allowed | Allowed (no §13 trigger when running locally) | Forbidden |
| 2 | A developer forks an Epicenter library to build their own app | Allowed | Their app must also be AGPL (kills adoption) | Forbidden |
| 3 | A company forks an Epicenter app and ships it under a new brand, closed-source | **Allowed** | Forbidden (must publish source) | Forbidden |
| 4 | A company forks the sync server and runs it as a competing hosted service | **Allowed** | Forbidden (§13 forces publishing source of running version) | Forbidden |

Scenarios 3 and 4 are the threat. AGPL handles both. We default to AGPL rather than proprietary for these scenarios because AGPL preserves the right to read and fork the code (consistent with the local-first ethos), still legally blocks SaaS clones via §13, and avoids the operational overhead of running a proprietary tier.

Scenario 4 (a hosted competitor) is the one where the license is most load-bearing, because hosting a fork is a low-effort, high-leverage attack on revenue. We extend AGPL to the consumer apps too (Whispering, Honeycrisp, etc.): on a locally-run app AGPL collapses to GPL semantics and gives little extra protection, but we accept that in exchange for one uniform "everything Epicenter ships is AGPL, the toolkit libraries are MIT" story, brand consistency, and zero rug-pull risk. The brand, distribution, and update cadence remain the real moats for end-user apps; the license is the backstop.

## Three-tier split

### Tier 1: MIT

**Applies to:** the embeddable toolkit libraries: `packages/workspace`, `packages/ui`, `packages/filesystem`, `packages/sync`, plus the toolkit-internal packages `packages/util`, `packages/encryption`, and `packages/identity`.

**Rationale:**
- Libraries: we want developers to embed `@epicenter/workspace` in their own projects with zero friction. AGPL would forbid that for closed-source consumers, killing adoption. The library is not what we sell.
- Toolkit-internal packages (`util`, `encryption`, `identity`): these are dependencies bundled into the MIT toolkit libraries, so they must be MIT-compatible for the toolkit to stay distributable as MIT. `@epicenter/identity` owns the capability and identity vocabulary shared by the MIT toolkit and the AGPL auth layer. They are not separately marketed.
- MIT-clean closure: the toolkit no longer depends on any AGPL package. `OwnerId` and `AuthState` live in `@epicenter/identity`; the room route and bearer subprotocol moved to the now-MIT `@epicenter/sync`; and the daemon takes its API base URL as config instead of importing the hosted constant. `bun run check:licenses` enforces this. `cli` stays AGPL because it also pulls AGPL `auth`.

### Tier 2: AGPL-3.0

**Applies to:** all apps (`apps/api`, `apps/team-api`, `apps/whispering`, `apps/honeycrisp`, `apps/opensidian`, `apps/fuji`, `apps/zhongwen`, `apps/tab-manager`, `apps/skills`, `apps/reddit`, `apps/landing`, `apps/posthog-reverse-proxy`), `packages/cli`, and the internal packages `packages/auth`, `packages/svelte-utils`, `packages/skills`, `packages/constants`, `packages/server`, `packages/client`.

**Rationale:**
- `apps/api` (hosted cloud: sync server, auth, AI inference; serves the same-origin dashboard SPA from its `ui/`): the infrastructure a competitor would need to clone Epicenter Cloud. AGPL §13 means any hosted fork must publish source, including improvements, which destroys the economics of forking-and-hosting. `apps/team-api` is the self-hosted team reference deployment.
- Consumer apps: AGPL gives little extra protection on a locally-run app (§13 collapses to GPL semantics), but they are AGPL for a uniform "everything Epicenter ships is AGPL" story and brand consistency. The toolkit libraries are the only MIT surface.
- Internal packages (`auth`, `svelte-utils`, `skills`, `constants`, `server`, `client`): private glue that composes the apps and hosted server; never marketed as an embeddable library, so AGPL with no adoption cost.

### Tier 3: Proprietary (deferred)

**Applies to:** none today, and none planned.

**Rationale:** Documented as an escape hatch for one specific situation: a real paying customer requires one specific feature that AGPL self-hosting would otherwise give away free. The tier will not be populated speculatively. The empty-tier end-state is the goal; populating it is a sign that hosting revenue alone was not enough.

**Convention if ever used:**
- Live in their own subdirectory, e.g. `apps/<name>/proprietary/` or a dedicated `enterprise/` top-level directory.
- `LICENSE` file in that directory contains an "all rights reserved" notice (template in this spec).
- `package.json` uses `"license": "SEE LICENSE IN LICENSE"`.
- Listed explicitly in the root `LICENSE` dispatch under a "Proprietary" section.
- Code is publicly visible on GitHub (for transparency and customer trust) but no rights are granted to use, copy, modify, or redistribute.
- Scoped to the smallest unit that solves the customer's problem. Do not gate adjacent features speculatively.

This is the same pattern Bitwarden uses for `bitwarden_license/` and Sentry uses for `getsentry/getsentry`. We treat it as a graduation path, not a default.

## Planned `apps/api` split

`apps/api` today is a kitchen sink: Yjs sync protocol, Postgres-backed persistence, auth, workspace management, AI inference. This is fine operationally but muddies the self-host story ("self-host `apps/api` but disable these 14 features").

When `apps/api` becomes uncomfortable to maintain as a single unit, split it:

```
apps/sync-server   pure Yjs sync protocol, genuinely self-hostable
                   on a VPS with no other Epicenter infrastructure.
                   AGPL.

apps/api           cloud platform: auth, Postgres, workspace mgmt,
                   billing hooks, admin endpoints. AGPL, but
                   practically requires the full Epicenter stack.

apps/dashboard     UI for apps/api. AGPL.
```

The split is architectural, not licensing. All three remain AGPL. The benefit is a cleaner self-host story for individuals and homelabbers (`apps/sync-server` alone) without conflating it with the cloud-platform code.

This is not blocking and not scheduled. Trigger to execute: `apps/api` becomes painful to keep as a single unit, or a community member wants to self-host the sync protocol without the rest.

## Per-package breakdown

All apps are AGPL-3.0. MIT is reserved for the embeddable toolkit libraries.

| Path | License | Notes |
|---|---|---|
| `apps/api` | AGPL-3.0 | Hosted cloud: sync server, auth, AI inference (its `ui/` is the same-origin dashboard SPA) |
| `apps/team-api` | AGPL-3.0 | Self-hosted team reference deployment |
| `apps/whispering` | AGPL-3.0 | Desktop transcription |
| `apps/honeycrisp` | AGPL-3.0 | Notes app |
| `apps/opensidian` | AGPL-3.0 | Note-taking with terminal |
| `apps/fuji` | AGPL-3.0 | Personal CMS |
| `apps/zhongwen` | AGPL-3.0 | Mandarin chat app |
| `apps/tab-manager` | AGPL-3.0 | Browser extension |
| `apps/skills` | AGPL-3.0 | Agent skill editor |
| `apps/reddit` | AGPL-3.0 | Reddit data importer |
| `apps/landing` | AGPL-3.0 | Public site |
| `apps/posthog-reverse-proxy` | AGPL-3.0 | Analytics proxy |
| `packages/workspace` | MIT | Core CRDT library (toolkit) |
| `packages/ui` | MIT | shadcn-svelte components (toolkit) |
| `packages/filesystem` | MIT | POSIX layer over Yjs (toolkit) |
| `packages/util` | MIT | Framework-agnostic runtime utilities (toolkit-internal) |
| `packages/encryption` | MIT | HKDF + blob crypto primitives (toolkit-internal; a dependency of the MIT `workspace`) |
| `packages/identity` | MIT | Capability and identity vocabulary shared by the MIT toolkit and AGPL auth layer |
| `packages/sync` | MIT | Yjs sync protocol primitives: wire format, room route, auth subprotocol (toolkit) |
| `packages/auth` | AGPL-3.0 | Framework-agnostic auth core (private, internal) |
| `packages/svelte-utils` (`@epicenter/svelte`) | AGPL-3.0 | Svelte 5 reactive helpers and auth wrapper |
| `packages/skills` | AGPL-3.0 | Skill definitions |
| `packages/constants` | AGPL-3.0 | Shared constants |
| `packages/cli` | AGPL-3.0 | `epicenter` CLI (depends on AGPL auth + constants, so AGPL rather than MIT) |
| `packages/server` | AGPL-3.0 | Shared Hono server library |
| `packages/client` | AGPL-3.0 | API client |

> **MIT-clean closure:** the MIT toolkit's entire dependency closure is MIT. `@epicenter/workspace` no longer imports from any AGPL package: shared capability state lives in `@epicenter/identity`, and the room route plus bearer subprotocol moved to the now-MIT `@epicenter/sync`. `cli` stays AGPL because it pulls AGPL `auth`. `bun run check:licenses` walks every package's dependency closure and fails if an MIT package can reach an AGPL one.

## Decision procedure for new packages

When adding a new package or app, ask in order:

1. **Is this an embeddable toolkit library other developers should drop into their own apps (or a utility bundled into one)?** → MIT. No further questions. Confirm its dependency closure is MIT-compatible, or document the AGPL deps.
2. **Is this an app (desktop, browser extension, CLI app, hosted service) that Epicenter ships?** → AGPL-3.0. Apps are AGPL for brand consistency and the uniform "everything we ship is AGPL, the toolkit is MIT" story, even where §13 gives little practical protection on a locally-run app.
3. **Is this internal/glue or server infrastructure (auth, server, constants, client) that composes the product rather than being marketed standalone?** → AGPL-3.0.
4. **Is there a real paying customer asking for one specific feature that AGPL would let them self-host for free?** → Proprietary, scoped to that feature, in its own subdirectory. Otherwise → AGPL. Never gate speculatively. The proprietary tier is reactive, not prospective.

When in doubt, default to MIT. License changes are easy in one direction (MIT → AGPL/proprietary on new code is fine for the copyright holder) and hard in the other (AGPL → MIT requires consent from every contributor, which is why CLAs exist; we don't have one).

## Contributor licensing posture

**No CLA. No DCO. No dual-licensing.**

Reasoning:
- We do not sell commercial AGPL exemptions to enterprises. Our revenue model is hosting, not licensing.
- Cal.com, dub.sh, Plausible, and most other open-core projects we are modeled on do not require CLAs either. The friction discourages contributors and provides no benefit for a hosting business.
- If we ever needed to relicense `packages/sync` or `apps/api` away from AGPL (e.g. to sell self-hosted enterprise licenses without copyleft), we would need either (a) a CLA from the start, or (b) consent from every external contributor at that point. We accept (b) as a future cost in exchange for present-day contributor friendliness. As of this spec, there are zero external contributors to AGPL components, so the cost is zero today.
- If a meaningful external PR lands on an AGPL component and we anticipate ever wanting to dual-license, we can add CLA Assistant (a GitHub bot, click-through CLA) at that point. We do not pre-commit to that decision.

By contributing to Epicenter, contributors agree their contributions are licensed under the same license as the file they are modifying. This is the standard "inbound = outbound" convention used by Linux, Rails, and most open source projects without formal CLAs.

## Prior art

Two clusters of prior art are relevant. We anchor to the first cluster (no proprietary tier, monetize hosting) and keep the second cluster as a graduation path if a specific enterprise deal forces it.

**Closest models (no proprietary tier, hosting-only revenue):**
- **Plausible Analytics:** AGPL throughout, single-founder-led for years, monetizes via hosted SaaS only. No proprietary, no CLA.
- **PostHog:** Apache and AGPL components, monetizes via hosted SaaS and enterprise SLA contracts on the same code. No proprietary tier in the standard sense.
- **Cal.com:** AGPL throughout, hosted SaaS, no CLA.
- **dub.sh:** AGPL throughout, hosted SaaS, no CLA.
- **Yjs:** MIT for the core library and client-side providers (`y-websocket`, `y-webrtc`, `y-indexeddb`); AGPL for `y-redis` (server-side scaling backend).

**Graduation models (proprietary tier alongside open core, only if needed):**
- **Liveblocks:** Apache-2.0 for client libraries; AGPL for server.
- **Bitwarden:** GPL/AGPL for clients and core server; proprietary for `bitwarden_license/` enterprise modules.
- **Sentry:** Migrated through several variants (MIT to BSL to FSL); historically used a `getsentry/getsentry` proprietary repo for paid features.

Our default model is closest to Plausible and PostHog: permissive for libraries, AGPL for apps and servers, hosting is the revenue surface, proprietary tier exists on paper but stays empty. We graduate toward the Bitwarden/Sentry pattern only if a specific enterprise customer pulls a specific feature into the proprietary tier.

## Proprietary LICENSE template

When the first proprietary module is added, use this text:

```
Copyright (c) 2023-2026 Braden Wong. All rights reserved.

This software and associated documentation files (the "Software") are
proprietary and confidential. The Software is made available on GitHub
for transparency and customer trust, but no license is granted to use,
copy, modify, merge, publish, distribute, sublicense, or sell copies of
the Software except as expressly permitted in writing by the copyright
holder or as required to view the source on GitHub.

For commercial licensing, contact: github@bradenwong.com

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```

## Open questions and review triggers

- Revisit if a meaningful external contributor lands a PR on `apps/api`, `apps/dashboard`, or `packages/sync`. Decide then whether to add CLA Assistant.
- Revisit if a specific paying customer requires a feature that AGPL would let them self-host for free. This is the trigger to populate the proprietary tier (one feature, scoped to a subdirectory). Until that happens, the tier stays empty by design.
- Revisit if `apps/api` becomes painful to maintain as a kitchen sink, or a community member asks to self-host the sync protocol alone. This is the trigger to execute the `apps/sync-server` split.
- Revisit if we sell self-hosted enterprise licenses. That would be the trigger for moving to a real dual-license posture (and retroactively adding CLAs).
