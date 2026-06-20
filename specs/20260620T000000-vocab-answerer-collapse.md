# Vocab answerer collapse: rename, browser-never-answers, hosted worker

Status: Draft. Date: 2026-06-20.

The build plan for the answerer redesign settled in this design pass. The durable
decisions live in ADRs; this spec is the dependency-ordered wave plan plus a
self-contained handoff prompt per wave. Delete this spec when the waves land
(the ADRs are the lasting record).

## Decisions (the lasting record is the ADRs)

- **ADR-0041** — every answerer is a worker; the **browser never answers**;
  blindness is per-agent; **BYOK is cloud-proxied**; the managed answerer is an
  on-demand hibernating Durable Object woken by the existing dispatch doorbell.
- **ADR-0042** — the agent loop is the worker's, over the doc-as-message-array;
  the engine stays a pure token source; durable doc-mediated approval. **Build
  deferred** to a real tool consumer (not Vocab).
- **ADR-0033** amended; **ADR-0025** amended (the ephemeral browser writer
  dissolves); **ADR-0024** note (tension resolved toward the hosted-worker
  quadrant). **ADR-0030** already settles model = agent (no model switcher) and
  the managed/published vs user-authored catalog.

## End state for Vocab

- One app: a single Chinese vocab assistant. One model (`VOCAB_MODEL`), one
  system prompt, `tools: []`.
- Two **durable** agents in the catalog, distinguished by trust location:
  - **Managed** (Epicenter-hosted worker, metered Gemini, cloud-proxied BYOK).
  - **Home daemon** (`vocab-home`, the user's own box).
- The browser writes user turns and renders the synced doc. It constructs no
  engine and runs no answer loop.
- Close the browser mid-answer → the worker keeps writing; resync catches up.

## Wave plan (each is one standalone, reviewable PR, in order)

| # | Wave | Depends on | Net |
|---|---|---|---|
| 1 | Rename zhongwen → vocab (incl. pre-release data ids) | — | mechanical, no behavior change |
| 2 | Daemon ships live (`vocab-home`) | 1 | proves worker-answers-over-sync on the user's box |
| 3 | Hosted managed worker (on-demand DO) | 1 | the managed answerer; the big build |
| 4 | Browser → renderer-only (the collapse) | 2, 3 | deletion PR; supersedes #2127 |
| 5 | F: agentic loop + doc approval (DEFERRED) | 4 + a tool consumer | not this milestone; ADR-0042 holds the design |

Rename is first so nothing rebases over it. Wave 4 is safe only once both
answerers (daemon + hosted) exist, so it follows 2 and 3.

## PR / branch disposition

- **#2127** (owner ⊥ engine): **superseded by wave 4.** The owner fork is deleted
  there. Cherry-pick only the metered-engine single-homing (`epicenterMeteredEngine`,
  the `@epicenter/zhongwen/engine` subpath) into the **worker** side in wave 3,
  not the browser. Close #2127 once wave 4 lands.
- **#2128** (presence slice 1): **parked.** Presence decorates liveness, never
  gates binding (the doc is a durable mailbox). Revisit as a fast-follow after
  wave 2, framed as the dead-mailbox warning ("you bound to your home daemon but
  nothing is home"). Do not merge it into this stack.
- `specs/zhongwen-conversation-deletion-refusal.md` — unrelated (deletion reclaim,
  terminal "Refused" status). Pre-existing hygiene smell; handle in a separate
  pass (convert to an ADR or delete). Wave 1 should rename its "zhongwen" mentions
  or delete it; it is not load-bearing here.

---

## Wave 1 — Rename zhongwen → vocab

**Goal.** A pure rename. `@epicenter/zhongwen` → `@epicenter/vocab` (package name,
directory `apps/zhongwen` → `apps/vocab`, every import, `ZHONGWEN_*` constants →
`VOCAB_*`, UI "Zhongwen" → "Vocab"). Because this is **pre-release**, also clean-
break the two data identities: workspace id `epicenter-zhongwen` → `epicenter-vocab`
and agent id `zhongwen-home` → `vocab-home`. The bilingual Chinese system prompt
and `gemini-3.5-flash` model are unchanged.

**Scope / files.**
- `apps/zhongwen/` → `apps/vocab/`: `package.json` (`name`), `zhongwen.ts`
  (`zhongwenWorkspace` id, `ZHONGWEN_*`, `THIS_DEVICE_AGENT_ID`, catalog),
  `mount.ts`, `epicenter-engine.ts`, `epicenter.config.ts`, `zhongwen.browser.ts`,
  `wrangler.jsonc` (`name`, the `zhongwen.epicenter.so` route → `vocab.epicenter.so`),
  `src/lib/session.ts`, `src/routes/.../ConversationView.svelte`,
  `ZhongwenSidebar.svelte` → `VocabSidebar.svelte`, the `@epicenter/zhongwen/engine`
  subpath export.
- Repo-wide consumers of `@epicenter/zhongwen` (grep the monorepo).
- `agents.test.ts` and any test asserting ids.

**Steps.**
1. `git mv apps/zhongwen apps/vocab`; rename files; update `package.json` name +
   exports map.
2. Find/replace `zhongwen` → `vocab`, `Zhongwen` → `Vocab`, `ZHONGWEN_` →
   `VOCAB_`, `epicenter-zhongwen` → `epicenter-vocab`, `zhongwen-home` →
   `vocab-home`, `THIS_DEVICE_AGENT_ID` stays (`this-device` is already neutral —
   though see wave 4, where it dissolves).
3. Update the custom domain in `wrangler.jsonc`.
4. Wipe dev rooms (manual: clear local IndexedDB + admin-wipe the DO room) so the
   new `epicenter-vocab` room starts clean.
5. Typecheck the workspace, run `apps/vocab` tests, biome.

**Acceptance.** `bun run` typecheck clean repo-wide; vocab tests green; no
remaining `zhongwen` string outside historical docs; app boots against the
`epicenter-vocab` room.

**Handoff prompt.**
> Rename the `@epicenter/zhongwen` app to `@epicenter/vocab` in the worktree
> `/Users/braden/Code/.worktrees/epicenter-row-childdocs`. This is pre-release, so
> clean-break everything including data identities: `git mv apps/zhongwen apps/vocab`,
> rename `@epicenter/zhongwen` → `@epicenter/vocab` (package name + the `/engine`
> subpath), `ZHONGWEN_*` → `VOCAB_*`, the workspace id `epicenter-zhongwen` →
> `epicenter-vocab`, the agent id `zhongwen-home` → `vocab-home`, the
> `zhongwen.epicenter.so` route → `vocab.epicenter.so`, and all UI "Zhongwen" →
> "Vocab" (rename `ZhongwenSidebar.svelte` → `VocabSidebar.svelte`). Keep the
> Chinese system prompt and `gemini-3.5-flash` model exactly. Grep the whole
> monorepo for `zhongwen`/`Zhongwen` and update every consumer. Do NOT change any
> answering behavior — this is a pure rename. Read the writing-voice skill for UI
> strings. Typecheck the repo, run the vocab app tests, run biome. One commit (or
> a small handful of mechanical commits). This is wave 1 of
> `specs/20260620T000000-vocab-answerer-collapse.md`.

---

## Wave 2 — Daemon ships live (`vocab-home`)

**Goal.** Make `vocab-home` a real co-deployable daemon a user can run, bind a
conversation to, close the browser, and have it answer over sync. The answer loop
is the existing `attachChatWorker`; this wave is about making the deploy real and
documented, not new answering machinery.

**Scope / files.** `apps/vocab/mount.ts`, `apps/vocab/epicenter.config.ts`, the
daemon entrypoint, deploy docs/README, the engine resolution
(`resolveDaemonStream` → byok-key ?? cloud-proxied-metered, ADR-0038). Verify the
child-doc observe loop hosts only `row.agent === 'vocab-home'` conversations.

**Acceptance.** A documented path to run the daemon locally; binding a conversation
to `vocab-home` and closing the browser yields an answer that appears on resync;
the existence-is-the-claim guard prevents any double-answer with a watching tab
(until wave 4 removes browser answering entirely).

**Handoff prompt.**
> In `apps/vocab` (worktree `/Users/braden/Code/.worktrees/epicenter-row-childdocs`,
> after wave 1), make the `vocab-home` daemon a real, documented deliverable per
> ADR-0024/0025/0041: a user co-deploys it, binds a conversation to `vocab-home`,
> closes the browser, and it answers over sync. The answer loop is the existing
> `attachChatWorker` (don't rewrite it). Confirm the child-doc observe loop hosts
> only conversations where `row.agent === 'vocab-home'`, and that `resolveDaemonStream`
> resolves byok-key ?? cloud-proxied-metered (ADR-0038). Write the co-deploy docs.
> Verify close-browser durability end-to-end. This is wave 2 of
> `specs/20260620T000000-vocab-answerer-collapse.md`.

---

## Wave 3 — Hosted managed worker (on-demand Durable Object)

**Goal.** The Epicenter-hosted answerer for the **managed** agent: an on-demand DO
that hibernates when idle, is woken by the existing dispatch doorbell when a turn
is written, syncs the conversation child doc as a y-protocols peer, runs the same
answer loop, streams parts into the doc, and hibernates again. BYOK is
cloud-proxied (the worker uses the user's key per request). This is the largest
wave but builds on primitives the room DO already proves.

**Reuse (do not reinvent).** `packages/server/src/room/` is already a hibernating
server-side Yjs peer: `createRoomCore` (runtime-agnostic, holds a live `Y.Doc`,
y-protocols SYNC, dispatch + presence), the Cloudflare adapter
(`durable-object.ts`: `acceptWebSocket`, `getWebSockets`, alarms,
`setWebSocketAutoResponse`), and the DO-SQLite update log. The **dispatch protocol**
(`dispatch_request`/`dispatch_inbound`) is the doorbell. The answer loop is the
daemon's `attachChatWorker`. `keepAlive`/`keepAliveWhile` (Cloudflare `Agent`
class pattern) prevents idle eviction during a streaming response.

**Scope / files.** A new hosted-worker DO (its own class + wrangler binding),
the cloud-proxied BYOK engine (the metered/BYOK `ChatStream` built worker-side,
re-homing #2127's `epicenterMeteredEngine` here), the doorbell wake endpoint, the
child-doc sync peer, the engine resolution (ADR-0038), `apps/api` wiring
(`apps/api/worker/index.ts`, billing remains hosted-only). Keep the worker a
separate spoke — never put answer logic in the room/anchor DO (ADR-0035).

**Acceptance.** A conversation bound to the managed agent is answered server-side
with no browser open; idle/approval-pause incurs no DO duration (hibernated);
generation bills only the stream wall-clock; billing/Autumn still gates the
metered path; a missed doorbell still gets answered (alarm backstop / next sync).

**Handoff prompt.**
> Build the Epicenter-hosted managed worker for Vocab per ADR-0041 (worktree
> `/Users/braden/Code/.worktrees/epicenter-row-childdocs`, after waves 1–2). It is
> an on-demand Durable Object that hibernates when idle, is woken by the existing
> dispatch doorbell (`dispatch_request`/`dispatch_inbound` in
> `packages/server/src/room/core.ts`) when a managed-agent turn is written, syncs
> the conversation child doc as a y-protocols peer, runs the existing
> `attachChatWorker` answer loop, streams parts into the doc, and hibernates again
> (free across approval pauses). Reuse the room DO's hibernation patterns
> (`packages/server/src/room/backends/cloudflare/durable-object.ts`:
> `acceptWebSocket`, `getWebSockets`, alarms) and use `keepAlive`/`keepAliveWhile`
> during streaming so a long generation isn't evicted. The engine is cloud-proxied:
> the worker uses the metered house key (and BYOK keys, server-side) — re-home
> #2127's `epicenterMeteredEngine` worker-side. Keep this a SEPARATE app-aware
> spoke; never add answer logic to the room/anchor DO (ADR-0035). Preserve the
> Autumn billing gate on the metered path (hosted-only, `apps/api/worker/billing`).
> Ground DO behavior against `cloudflare/cloudflare-docs` via DeepWiki before
> relying on memory. This is wave 3 of
> `specs/20260620T000000-vocab-answerer-collapse.md`.

---

## Wave 4 — Browser becomes renderer-only (the collapse)

**Goal.** The deletion PR. The browser stops answering. Now that the managed
(wave 3) and daemon (wave 2) workers both answer, delete the browser answerer and
the owner fork.

**Scope / deletions.**
- `apps/vocab/.../ConversationView.svelte`: remove the `browserEngines`,
  `resolveEngine`, the `answer`/`answersHere`/owner branch, and the `{ answer }`
  passed to `bindConversation`. The view opens the doc and renders; it writes user
  turns via `convo.send`.
- Remove the `owner: 'ephemeral' | 'durable'` field from `AgentConfig` and the
  catalog; both agents are durable, keyed by trust location. The `this-device`
  ephemeral agent dissolves into the **Managed** agent (Epicenter-hosted).
- Delete `attachChatBrowserAnswerer` usage; if no consumer remains, delete it from
  `packages/workspace/src/ai/` (and its export + test).
- Remove the browser-side `Engine`/`resolveEngine`/`epicenterMeteredEngine`
  surface from the app (engines are worker-only now).
- Reshape the catalog/picker: Managed + Home daemon, both durable.
- Close PR #2127 as superseded.

**Acceptance.** The browser never opens an answerer; every answer comes from a
worker; closing the browser never stops an answer; one answering path remains; no
dead `owner`/`Engine`/browser-answerer code; tests green. Run
post-implementation-review + collapse-pass on the deletion.

**Handoff prompt.**
> Make the Vocab browser renderer-only per ADR-0041 (worktree
> `/Users/braden/Code/.worktrees/epicenter-row-childdocs`, after waves 1–3). Delete
> the browser answerer: in `ConversationView.svelte` remove `browserEngines`,
> `resolveEngine`, the `answer`/`answersHere`/owner branch, and the `{ answer }`
> arg to `bindConversation` (the view just opens + renders the doc and writes user
> turns via `convo.send`). Remove the `owner: 'ephemeral' | 'durable'` field from
> `AgentConfig` and the catalog — both agents are now durable, distinguished by
> trust location; the `this-device` ephemeral agent dissolves into the Managed
> (Epicenter-hosted) agent. Delete `attachChatBrowserAnswerer` and the browser-side
> `Engine`/`resolveEngine`/`epicenterMeteredEngine` surface if no consumer remains
> (check exports + tests). Reshape the picker to Managed + Home daemon. Verify
> closing the browser mid-answer no longer stops the answer. Run
> post-implementation-review and collapse-pass on the deletion. Close PR #2127 as
> superseded by this wave. This is wave 4 of
> `specs/20260620T000000-vocab-answerer-collapse.md`.

---

## Wave 5 — F: agentic loop + doc-mediated approval (DEFERRED)

Not this milestone. The design is ADR-0042: the worker owns the loop over the
doc-as-message-array; the engine stays a pure token source; approval is a durable
single-writer doc region (the `cancelRequestedAt` pattern). Build only when a real
tool consumer exists (opensidian / tab-manager, which have actions) — never Vocab,
which has no tools and rides the unified path with `tools: []` for free. The
loop-engine choice (hand-roll over the existing TanStack adapters vs Vercel
`streamText` vs roll-your-own) is left open in ADR-0042 and decided at build time.

## Open items carried forward

- Loop engine for F (ADR-0042 open question). Lean: hand-roll over
  `@epicenter/ai-adapters`'s existing TanStack adapters.
- Presence (#2128) as the dead-mailbox warning, fast-follow after wave 2.
- Browser-local BYOK (key never leaves the device) — additive future option, does
  not disturb ADR-0041.
- `specs/zhongwen-conversation-deletion-refusal.md` hygiene (convert to ADR or
  delete) — separate pass.
