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
- `apps/email` (the 2026-06-06 hosted server-proxy webmail spec) is refused; Local Mail is the only Gmail client. Its spec is deleted; the deleted `GOOGLE_MAIL_CLIENT_ID`/`GOOGLE_MAIL_CLIENT_SECRET` Web-app OAuth client is not Local Mail's client, do not reuse it. [ADR-0083]
- The mirror shape is a port of `local-books`, not a fresh design. Read `apps/local-books/src/{sync,qb-client,db,token-store}.ts` and `apps/local-books/src/books/recategorize.ts` before inventing anything; the spec's mapping table names the exact file:line correspondences.

## Current state

- Nothing built yet. `apps/local-mail` does not exist.
- `apps/local-books` is the reference implementation; it is shipped and stable on `main` (stdio MCP server, #2214, ADR-0073).
- Base is `main`. A concurrent session has docs work on `chore/scrub-stale-dispatch-vocabulary`; coordinate, do not force-push.
- **Phase 0 mostly done 2026-06-30** (throwaway script, not committed — lived in a scratchpad dir, gone with the session that ran it). Real findings landed in the spec's mapping table and open questions 3/4 (both marked RESOLVED/PARTIALLY RESOLVED). Open question 5 (OAuth delivery mechanism) also resolved. One piece left: the `historyId` expiry window itself needs a genuine multi-day wait against a saved baseline (`historyId` 554264 from `braden@epicenter.so`, saved 2026-06-30T18:11:47-07:00) — that baseline and its refresh token are NOT preserved anywhere durable (scratchpad only), so a fresh multi-day check will need `connect` re-run from scratch. A live Desktop OAuth client already exists for this: `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` in Infisical `/apps/local-mail`, reusable directly, do not create another.

## Start here, in order

1. **Optional follow-up to Phase 0**: if the `historyId` expiry window still matters before Phase 1 schema decisions lock in, re-run a throwaway probe against the existing `/apps/local-mail` Infisical client, save a fresh baseline `historyId`, and check back after several days (or immediately continue to Phase 1 and treat this as a parallel, non-blocking check — nothing else in Phase 1 depends on knowing the exact number).
2. **Phase 1**: `mail.db` schema (`messages`/`threads`/`labels` + `_meta` kv), backfill, incremental poll loop. No UI, no writes yet. Note the confirmed CDC-shape finding: Gmail's `history.list` is thinner than QuickBooks' `/cdc` — `messagesAdded` records need a follow-up `messages.get` for content, `labelsAdded`/`labelsRemoved` records carry enough to update in place. A no-change response has no `history` key at all, don't treat it as `.length === 0`. `apps/local-mail` does not exist yet; scaffold it from-scratch (`package.json`, `tsconfig.json` extending the repo's leaf-tier base, per the `tsconfig` skill), templated on `apps/local-books` for the mirror logic. No existing app combines a Tauri shell with a third-party-API OAuth mirror the way Local Mail needs — `apps/fuji`/`apps/whispering` are the Tauri shell/`src-tauri` template, `apps/local-books` is the mirror/CDC/OAuth-mechanics template; there is no single app to copy wholesale.
3. **Phase 2**: connect flow (both modes), Tauri OAuth wiring. Open question 5 is resolved: PKCE + loopback callback (`127.0.0.1:port`, OS-assigned, no fixed port to pre-register), NOT a Tauri deep-link/custom URI scheme — Google's Desktop client type refuses custom schemes outright. Google Cloud Console does issue Desktop clients a `client_secret`; the token exchange still includes it.
4. **Phase 3**: write-through actions (archive/label) + reconciliation.
5. **Phase 4**: UI — the deleted `apps/email` spec's "UI Shape" section (preserved verbatim in the Local Mail spec's Appendix, since the old spec was never committed and git history can't recover it) is still valid reference even though its transport model was refused (ADR-0083); reuse it, don't redesign it.

## Open questions the owner must resolve, do not guess

1. Does the existing secret vault (ADR-0074) extend to self-host, so a second device can pick up the Gmail refresh token via sync instead of re-consenting? Verify against the vault's actual shipped scope, don't assume.
2. Default poll interval (foregrounded vs backgrounded/idle). Not decided.

## Constraints (repo rules)

- Use bun (`bun run`, `bun test`, `bun install`, `bunx`), never npm/yarn/pnpm/node/npx.
- Stage specific files only; never `git add .` or `git add -A`. No AI or tool attribution in commits.
- Do edits in a disposable git worktree on its own branch, OUTSIDE the repo dir (load `worktree-hygiene`).
- No em dash (U+2014) or en dash (U+2013) anywhere; use colon, comma, semicolon, or parens. Load `writing-voice` for any user-facing text.
- Library code: no `console.*`; use `wellcrafted/logger` (CLIs, tests, benchmarks excepted).
- Verify Gmail API / Tauri OAuth behavior against official docs before relying on it (per repo's external-grounding rule); this spec's own open questions 3-5 are exactly that kind of claim.

## If you get stuck

The owner (Braden) decides the open questions above (vault-extends-to-self-host, poll interval, whether `apps/email` survives). Do not guess on those; surface them. Everything else in the spec and the two ADRs is settled; act on it directly.
