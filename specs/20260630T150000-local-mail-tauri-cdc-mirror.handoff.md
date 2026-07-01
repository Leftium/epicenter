# Handoff: Local Mail (Tauri Gmail CDC mirror)

Cold-start continuation prompt. Canonical spec: `specs/20260630T150000-local-mail-tauri-cdc-mirror.md`. Durable decisions: `docs/adr/0081-*.md`, `docs/adr/0082-*.md`.

---

You are starting the "Local Mail" build for Epicenter (a local-first workspace platform; Bun monorepo, packages under `packages/`, apps under `apps/`). Read these first, in order:

- `docs/adr/0081-per-upstream-oauth-concurrency-decides-mirror-topology.md` — why Gmail (unlike QuickBooks/Local Books) can materialize a mirror independently per device, no box required
- `docs/adr/0082-local-mail-mirror-is-push-free-polling-collapsing-hosted-vs-self-host-to-one-oauth-client-id.md` — sync is plain polling (no push/Pub/Sub), hosted vs self-host collapses to one `clientId` override
- `specs/20260630T150000-local-mail-tauri-cdc-mirror.md` — the build plan, the `local-books` mapping table, and the open questions

## Goal

Build `apps/local-mail`, a Tauri desktop app that mirrors Gmail into a local SQLite database using the same CDC-cursor and write-through discipline `apps/local-books` already proved against QuickBooks, working identically in hosted (Epicenter OAuth Client ID) and self-hosted (operator's own Client ID) mode.

## The vision in one paragraph

Each device authorizes Gmail directly (Google permits up to 100 concurrent grants per account, ADR-0081) and runs its own poll loop against `users.history.list`, no server, no push, no webhook, in either mode. The mirror is a straight port of `local-books`'s shape: one table per entity (`messages`/`threads`/`labels`) with `raw` JSON + virtual columns, a single `history_id` cursor in a `_meta` kv table advanced only inside the same transaction as committed rows, full resync on a stale/expired cursor, write-through actions (archive/label/send hit Gmail first, the mirror is folded in after). The only thing that differs between hosted and self-host is which Google OAuth Client ID fronts the consent screen; that's a single defaultable value, `GmailApp = { clientId?: string }`.

## Decisions already made, do NOT reopen

- No push, no Pub/Sub, no webhook, in either mode. Plain interval polling only. [ADR-0082]
- Hosted vs self-host is exactly one override value (`clientId`); the mirror/schema/poll-loop/write-through code path is identical in both. [ADR-0082]
- Self-host operators register their own Google Cloud project and OAuth client; do NOT let self-host reuse Epicenter's Client ID (breaks the sovereignty point of self-hosting). [ADR-0082 rejected alternatives]
- This is a SEPARATE app from `apps/email` (the 2026-06-06 hosted server-proxy webmail spec). Do not merge them or treat one as superseding the other; they solve different problems (thin always-online webmail vs. thick offline-capable native mirror). [spec header, user-confirmed 2026-06-30]
- The mirror shape is a port of `local-books`, not a fresh design. Read `apps/local-books/src/{sync,qb-client,db,recategorize,token-store}.ts` before inventing anything; the spec's mapping table names the exact file:line correspondences.

## Current state

- Nothing built yet. `apps/local-mail` does not exist. This is Phase 0.
- `apps/local-books` is the reference implementation; it is shipped and stable on `main` (stdio MCP server, #2214, ADR-0073).
- Base is `main`. A concurrent session has docs work on `chore/scrub-stale-dispatch-vocabulary`; coordinate, do not force-push.

## Start here, in order

1. **Phase 0 (do this before any schema/UI work): the Gmail History API throwaway script.** Modeled on `apps/local-books/src/qb-client.ts`'s `cdc()`/`queryAll()`, against a real test Gmail account. Answers open questions 3 and 4 in the spec empirically: actual `historyId` expiry window (Gmail's retention is dynamic, narrower than QuickBooks' fixed 30 days), and whether backfill needs chunking in a long-lived Tauri process the way it would inside a Cloudflare Worker (it likely doesn't, but confirm).
2. **Resolve spec open question 5 (OAuth PKCE wiring) against current Google Desktop-app OAuth docs** before building the connect flow — loopback redirect handling and Tauri custom-URI-scheme registration are the most likely real-world gotcha in this whole design.
3. **Then Phase 1**: `mail.db` schema (`messages`/`threads`/`labels` + `_meta` kv), backfill, incremental poll loop. No UI, no writes yet.
4. **Phase 2**: connect flow (both modes), Tauri OAuth wiring.
5. **Phase 3**: write-through actions (archive/label) + reconciliation.
6. **Phase 4**: UI — the old `apps/email` spec's "UI Shape" section (3-pane `@epicenter/ui` layout) is still valid reference even though its transport model doesn't apply; reuse it, don't redesign it.

## Open questions the owner must resolve, do not guess

1. Does the existing secret vault (ADR-0074) extend to self-host, so a second device can pick up the Gmail refresh token via sync instead of re-consenting? Verify against the vault's actual shipped scope, don't assume.
2. Default poll interval (foregrounded vs backgrounded/idle). Not decided.
3. A background review surfaced a real question worth relaying to the owner before much work lands: **does `apps/email` (webmail) still earn its place next to Local Mail?** Webmail's only real justification is no-install/mobile reach (Tauri can't ship to iOS/Android); every other reason ("quick thin client", "onramp") is weaker and nobody has stated a committed requirement for it. Worth a direct ask before investing further in either spec, not a blocker for starting Local Mail itself.

## Constraints (repo rules)

- Use bun (`bun run`, `bun test`, `bun install`, `bunx`), never npm/yarn/pnpm/node/npx.
- Stage specific files only; never `git add .` or `git add -A`. No AI or tool attribution in commits.
- Do edits in a disposable git worktree on its own branch, OUTSIDE the repo dir (load `worktree-hygiene`).
- No em dash (U+2014) or en dash (U+2013) anywhere; use colon, comma, semicolon, or parens. Load `writing-voice` for any user-facing text.
- Library code: no `console.*`; use `wellcrafted/logger` (CLIs, tests, benchmarks excepted).
- Verify Gmail API / Tauri OAuth behavior against official docs before relying on it (per repo's external-grounding rule); this spec's own open questions 3-5 are exactly that kind of claim.

## If you get stuck

The owner (Braden) decides the open questions above (vault-extends-to-self-host, poll interval, whether `apps/email` survives). Do not guess on those; surface them. Everything else in the spec and the two ADRs is settled; act on it directly.
