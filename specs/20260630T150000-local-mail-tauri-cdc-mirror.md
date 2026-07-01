# Local Mail: Tauri Gmail CDC Mirror

**Date**: 2026-06-30
**Status**: Draft (design settled via ADR-0081/ADR-0082; not yet executed)
**Relation to `apps/email`**: A separate app, not a revision of `specs/20260606T114052-email-client-architecture.md`. That spec is a hosted-only, server-proxy webmail SPA (browser never talks to Gmail, no local storage, no self-host mode). Local Mail is a native desktop app that materializes its own local SQLite mirror and talks to Gmail directly, working identically hosted or self-hosted. They can coexist the way `local-books` (CLI/MCP) and a hypothetical hosted books UI would: same upstream, two different consumption shapes, no shared code forced between them.

## One sentence

`apps/local-mail`, a Tauri desktop app, authorizes Gmail directly per device (no server proxy) and materializes a local SQLite mirror using the same CDC-cursor and write-through discipline `local-books` already proved against QuickBooks, syncing by plain interval polling with no push path, working identically whether the user signs into Epicenter (hosted OAuth Client ID) or self-hosts (their own registered Client ID).

## Durable decisions (do not re-derive, read the ADRs)

- **ADR-0081**: Gmail's OAuth policy permits up to 100 concurrent refresh tokens per account per Client ID, so each device may hold its own independent grant and mirror. This is what makes Local Mail possible at all without a box/relay, unlike Local Books.
- **ADR-0082**: Sync is plain interval polling of `history.list`, never push/Pub/Sub/webhook, in either mode. Hosted vs self-host collapses to one override value, `GmailApp = { clientId?: string }`. Read the ADR before touching sync mechanics or the mode-selection UI; both are already decided.

## The `local-books` mapping (read `apps/local-books` before writing any of this)

Local Mail's mirror is not a new design, it is `local-books`'s proven shape applied to a different upstream. Confirmed against the actual `local-books` code (not guessed):

| `local-books` (QuickBooks) | Local Mail (Gmail) |
|---|---|
| `client.cdc(entities, cursorBefore)` (`qb-client.ts:227`) | `users.history.list(startHistoryId)` |
| `decideMode`: FULL if no cursor / stale / backstop, else INCREMENTAL (`sync.ts:28-63`) | Same shape; Gmail's cursor window is ~7 days (narrower than QB's 30d), so "stale" triggers faster |
| One table per entity, `raw` JSON + `json_extract` virtual columns (`db.ts:171-192`) | `messages`, `threads`, `labels` tables, `raw` JSON + virtual columns for subject/from/snippet/labelIds |
| `_meta` kv: `cdc_cursor`, `last_full_pull_at` (`db.ts:31-48`) | `_meta` kv: `history_id`, `last_full_pull_at` |
| Write-through: `recategorizeExpense` hits QB live first, folds the response back after (`recategorize.ts:139-252`) | Archive/label/send hits Gmail first, folds the response back; mirror is never the write target |
| Credentials in a separate `0600 credentials.json`, apart from `books.db` (`token-store.ts:9-13`) | Refresh token AES-GCM encrypted, kept apart from `mail.db` for the same reason: the query surface should never be able to read a token |
| Cursor advances only inside the same transaction as the committed rows (`db.ts:286-339`) | Same: `history_id` only advances after a batch commits, crash-safe re-pull otherwise |
| No daemon; sync on-demand or `--interval` poll loop (`sync.ts:328-342`) | Same on-demand-or-interval shape, but Local Mail is a live desktop app so the interval is always-on while the app runs, not manually invoked |

Do not invent a different mirror shape. If something here doesn't fit Gmail's actual API surface, that's a reason to adapt this table, not to redesign from scratch.

## Mode selection

```
GmailApp = { clientId?: string }
  undefined → Epicenter's baked-in, CASA-verified Client ID (hosted mode)
  present   → operator's own registered Client ID (self-host mode)

connectGmail(app: GmailApp)   — the one choke point, both modes
  → opens Google's PKCE consent screen (Desktop app client type, no secret)
  → returns a refresh token, same shape either way
  → everything downstream (mail.db, poll loop, write-through) is identical
```

Self-host operators must register their own Google Cloud project and OAuth client; reusing Epicenter's Client ID is refused (ADR-0082's "considered alternatives") because it would make self-host not actually sovereign from Epicenter's infrastructure.

## Data model sketch

```
mail.db (per device, local SQLite)
  messages  { id, thread_id, raw (json), snippet, from, subject, label_ids, ... }
  threads   { id, raw (json), ... }
  labels    { id, raw (json), name, ... }
  _meta     kv: history_id, last_full_pull_at, last_synced_at

credentials  (kept OUT of mail.db, same reasoning as local-books' token-store.ts)
  connected_mail_accounts: { account_id, email, refresh_token_enc (AES-GCM), client_id_used }
```

## Open questions (owner decides, do not guess)

1. **Cross-device token sharing.** Does the existing secret vault (ADR-0074) extend to self-host instances? If yes, a second device picks up the encrypted refresh token via normal sync and skips re-consenting Gmail (mirrors how a hosted user gets it for free). If the vault is hosted-only, self-host multi-device needs its own answer, not yet designed. Verify against the vault's actual shipped scope before assuming either way.
2. **Poll interval.** Local-books' CLI leaves `--interval` to the operator. Local Mail is a live app; what's the default? 30-60s is well inside Gmail's quota (`history.list` ≈ 2 units against 6,000/min/user), but the interval should probably shorten while the app is foregrounded and lengthen or pause when backgrounded/idle. Not yet decided.
3. **Historyid expiry window.** Gmail's retention for `startHistoryId` is dynamic and narrower than QuickBooks' fixed 30-day CDC window (`local-books`' basis for its staleness backstop). Confirm the actual current window against Gmail's docs before porting `decideMode`'s staleness threshold verbatim.
4. **Backfill chunking.** `local-books`' full pull runs in a single CLI invocation with no subrequest cap (it's a long-lived process, not a Worker). Local Mail's Tauri process has no such cap either, so backfill chunking (a real concern in the old server-proxy `apps/email` spec, which runs inside Cloudflare Workers) likely does not apply here — confirm this isn't a hidden constraint before assuming it away.
5. **Where does the OAuth code exchange happen?** Desktop app clients use PKCE with no secret, so the exchange can happen entirely client-side in Tauri, no server round-trip needed in either mode. Confirm this against Google's current Desktop-app OAuth docs before building the connect flow; this is the one piece of the design most likely to have a real-world gotcha (loopback redirect handling, custom URI scheme registration for Tauri).

## Considered and rejected: browser-only instead of Tauri

Could Local Mail just be a web app (wasm SQLite / OPFS, or Turso) instead of native? OAuth transfers cleanly (Google supports client-side PKCE with a public client, no server needed there either). Storage and background sync do not:

- **wasm SQLite on OPFS** is genuinely persistent, no server, but sandboxed to the browser origin — nothing outside that tab, including the stdio MCP server that's the entire reason `local-books` exposes its mirror as a queryable file, could open it. That's a different architecture, not a web port of this one.
- **Turso** (remote libSQL + embedded-replica sync) puts a server back in the data path if pointed at a hosted instance, or makes the self-hoster operate a server, both of which this design explicitly refuses (ADR-0082).
- Browser tabs cannot run a reliable background poll daemon; backgrounded/closed tabs get throttled or killed, unlike a native process.

Rejected as a Tauri replacement. A tab-scoped, no-MCP, install-free mode is a legitimate fourth app if no-install reach ever becomes a committed requirement, not a merger of this spec.

## First slice (de-risk before schema work)

Before writing `mail.db`'s schema in earnest, run a throwaway script against a real test Gmail account, modeled on `apps/local-books/src/qb-client.ts`'s `cdc()`/`queryAll()`, to confirm:
- `history.list` record shapes and what a label-change vs. add vs. delete record actually looks like
- the real `historyId` expiry window in practice
- `messages.get` batch-get cost and payload shape for `format=full`

This answers open questions 3 and 4 empirically instead of from docs alone, and should land before any schema or UI work starts.

## Phased plan (sketch, refine once the throwaway script lands)

```
Phase 0: Throwaway Gmail History API script (de-risk, see above)
Phase 1: mail.db schema + backfill + incremental poll loop, no UI, no writes
Phase 2: connect flow (both modes) + Tauri OAuth PKCE wiring
Phase 3: write-through actions (archive/label) + reconciliation
Phase 4: UI (can likely reuse @epicenter/ui patterns from the apps/email
         spec's UI Shape section — that part of the old spec is still valid,
         it's the transport/storage model that diverged, not the UI)
```

## References

- `apps/local-books/src/{sync,qb-client,db,recategorize,token-store}.ts` — the mirror shape being ported
- `docs/adr/0081-*.md`, `docs/adr/0082-*.md` — the settled decisions this spec builds on
- `specs/20260606T114052-email-client-architecture.md` — the separate webmail app; its "UI Shape" and Gmail scope/CASA research (Findings 1-3) are still relevant background even though its transport model does not apply here
- Gmail History API: https://developers.google.com/gmail/api/guides/sync
- Gmail quota: https://developers.google.com/gmail/api/reference/quota
