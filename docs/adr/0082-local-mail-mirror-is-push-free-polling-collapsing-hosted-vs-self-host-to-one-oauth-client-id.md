# 0082. Local Mail's mirror is push-free CDC polling; hosted vs self-host collapses to one OAuth Client ID

- **Status:** Proposed
- **Date:** 2026-06-30
- **Relates:** [ADR-0081](0081-per-upstream-oauth-concurrency-decides-mirror-topology.md) (establishes Gmail permits per-device grants, unlike Local Books), [ADR-0064](0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md) (the single-cursor CDC discipline this borrows), [ADR-0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) (write-through discipline this borrows), [ADR-0069](0069-epicenter-is-one-runnable-star-plus-services-called-by-url-and-token.md) / [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) (the defaultable-override shape this converges on)

## Context

ADR-0081 settled that Gmail's OAuth concurrency policy permits each device to hold its own independent grant and mirror, unlike Local Books/QuickBooks. That leaves two open questions for the "Local Mail" Tauri app: how a device's mirror actually learns about new mail, and how hosted vs self-host modes differ once each device already talks to Gmail directly. Two sync mechanisms were on the table: Cloud Pub/Sub push (`users.watch`, near-real-time, requires a publicly reachable webhook) and plain interval polling of `users.history.list` (the same changefeed shape `local-books` already runs against QuickBooks's CDC endpoint). Push is trivial for Epicenter Cloud to own but has no default home for a self-hosted or offline desktop device, which would force a permanent latency/capability split between modes. Gmail's `history.list` costs ~2 quota units against a 6,000-units/minute/user ceiling, cheap enough to poll every 30-60 seconds from a single device with no shared-tenant cost, unlike a multi-tenant SaaS server polling on behalf of many accounts at once.

## Decision

**Local Mail syncs by plain interval polling of `history.list`, in both hosted and self-hosted mode. There is no push, Pub/Sub, or webhook path.** Each device holds its own Gmail OAuth grant (per ADR-0081) and independently polls on a timer, no triggering or "did something change" logic needed. The mirror follows `local-books`'s proven CDC discipline: one `historyId` cursor per account, advanced only inside the same transaction as the committed rows (ADR-0064's pattern), full resync on a 404/expired cursor. Writes are write-through: sent directly to Gmail first, folded into the mirror only after Gmail accepts (ADR-0061's pattern).

Because this sync path never runs through Epicenter Cloud, the only remaining difference between hosted and self-host is **which Google OAuth Client ID fronts the Gmail consent screen**. Hosted mode defaults to Epicenter's own CASA-verified Client ID; self-host substitutes the operator's own registered Client ID. This is a single defaultable override value — `GmailApp = { clientId?: string }` — structurally the same shape as the `Instance = {baseUrl, token?}` pattern (ADR-0069/ADR-0075), even though what varies (an app identity string, not a server address) is different in kind.

## Consequences

- No Pub/Sub topic/subscription lifecycle, no webhook receiver, no Epicenter Cloud ownership of any live relay surface for mail. Epicenter Cloud's only role in hosted mode is supplying a config value baked into the build.
- New-mail latency is bounded by the poll interval (tens of seconds), not instant. This is an explicit refusal, not an oversight: the UX loss is small, and it deletes the entire push subsystem plus the hosted/self-host latency asymmetry push would otherwise create.
- Hosted and self-host share one code path end to end (schema, poll loop, write-through, token storage); they differ only in `clientId`. Local Mail is not box-owned like Local Books stays under ADR-0081.
- Self-host still carries real one-time provisioning cost (Google Cloud project, consent screen, possibly CASA verification) even though the runtime artifact collapses to one string. Provisioning cost and runtime shape are separate axes; the collapse only applies to the latter.
- Cross-device sync of the refresh token, so a second device does not need to re-consent, depends on whether the existing secret vault (ADR-0074) extends to self-host instances. Not yet confirmed; open question for the spec.
- Instant push remains addable later as a purely additive, hosted-only enhancement (a ping that calls the same polling function early) if it ever becomes a real product requirement. It does not require redesigning this base.

## Considered alternatives

- **Push via Cloud Pub/Sub + webhook for hosted, poll fallback for self-host.** Rejected: permanently splits the two modes on latency and capability, and gives Epicenter Cloud an ongoing runtime role in mail sync that polling deletes entirely. The infrastructure cost (topic/subscription lifecycle, webhook auth, 7-day watch re-arm) is large relative to the UX it buys for a single-device polling workload.
- **Self-host operators reuse Epicenter's OAuth Client ID instead of registering their own.** Rejected: undermines the actual reason to self-host (sovereignty from Epicenter's infrastructure and quota) and ties operator uptime/rate limits to a Google Cloud project they do not control, the same reason self-host Whispering runs its own server rather than pointing at Epicenter's.
