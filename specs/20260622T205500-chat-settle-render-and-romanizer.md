# Stream raw, render rich on settle; romanization as a pluggable one-shot

**Date**: 2026-06-22
**Status**: Draft
**Owner**: Braden
**Branch**: braden-w/vocab-local-inference-test

## One Sentence

Tie a chat message's render richness to the loop's existing live/settled boundary (stream the raw text while it is in-flight, run markdown + romanization exactly once when it persists), which collapses the per-token O(n²) render and turns romanization into a one-shot pure function that any language can plug into.

## Overview

The vocab chat re-derives a fully rendered, annotated, sanitized HTML view from the entire accumulated message string on every streamed token. This spec stops that: a streaming message renders as raw text; a settled message renders rich once. The same decision makes romanization (pinyin today, romaji/others later) a one-shot `Romanizer` strategy injected per app.

## How to read this spec

```txt
Read first:    One Sentence · Motivation · Architecture · Implementation Plan · Success Criteria
Read for why:  Research Findings · Design Decisions · The Romanizer contract · Open Questions
Reference:     Call sites · Edge Cases · References
```

## Motivation

### Current State

`ChatMessage` renders every message identically, and `AssistantProse` re-runs the full pipeline on every reactive update. During streaming the loop calls `notify()` on each `text-delta`, so this runs once per token over growing content:

`apps/vocab/src/routes/(signed-in)/components/AssistantProse.svelte`:

```svelte
const html = $derived.by(() => {
  const raw = marked.parse(content, { breaks: true, gfm: true }) as string;
  const annotated = showPinyin ? annotateHtml(raw) : raw;
  return DOMPurify.sanitize(annotated, PURIFY_CONFIG);
});
// <div class="prose prose-sm">{@html html}</div>
```

`apps/vocab/src/lib/pinyin/annotate.ts` walks the full HTML and wraps every CJK char in `<ruby>` per call.

This creates problems:

1. **O(n²) render**: Each of `marked.parse`, `annotateHtml`, `DOMPurify.sanitize`, and the `{@html}` full-DOM replace is O(content length) and runs once per token. Summed over a turn: O(n²). Measured symptom: the first word appears instantly, then the UI visibly chugs as the message grows.
2. **Not the romanization per se**: Stripping pinyin still leaves O(n²) via `marked` + `{@html}`. The disease is "re-derive the whole output from the whole string every delta," not ruby. Ruby is just the heaviest constant.
3. **Romanization is forced to be incremental**: Any attempt to keep romanization live during streaming forces an incremental, append-stable, memoized romanizer, which is brutal to implement per language (incremental Japanese morphological analysis, for instance).

### Desired State

```txt
LIVE   (message is the in-flight turn) -> render RAW text. Cheap, append-only.
SETTLED (message has persisted)         -> render RICH once: markdown + romanization.
```

Romanization is an injected one-shot:

```ts
type Segment = { text: string; reading?: string };
type Romanizer = (text: string) => Segment[] | Promise<Segment[]>;
```

## Research Findings

### Server streaming is smooth; the lag is client-side

Measured raw Ollama SSE for `qwen3:30b-a3b-instruct-2507-q4_K_M` (warm), 145-token reply:

```txt
TTFT = 147 ms   then median inter-token gap 8.5 ms (~105 tok/s)   max gap = 147 ms (first token only)
```

After the first token the server is a clean firehose. The perceived "first word then lag" is the client render pipeline, not the network or the model.

### How the ecosystem renders streaming markdown

| Library | Accumulation | Markdown render under streaming | Romanization analogue |
| --- | --- | --- | --- |
| vercel/ai | `text-start`/`text-delta`/`text-end` parts (server↔client wire); raw OpenAI SSE underneath | **Block-level memoization**: `marked.lexer` splits into blocks, `React.memo` per block, only the trailing block re-parses; plus `experimental_throttle` and `smoothStream` | none built in |
| TanStack/ai | deltas accumulate into `TextPart` via `StreamProcessor`; Svelte `$state` per delta | none built in (app's job); for structured output it builds a `partial` object instead of re-parsing | none built in |
| Epicenter (today) | loop `notify()` per delta; `$derived.by` recompute | full re-parse every token (O(n²)) | per-token full-HTML walk |

**Key finding**: Block memoization (Vercel) is the *general-chat* fix and keeps rich streaming at O(n), but it requires the romanizer to be incremental-safe. No library solves streaming romanization; it is our specific need.

**Implication**: For a product whose core feature is per-language romanization, the cheaper and more powerful move is to refuse live romanization and run it once on settle. That deletes the incremental-render subsystem *and* makes the romanizer a trivial pure function.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Render boundary | 2 coherence | Rich only on settle; raw while live | Reuses the loop's existing `turn` (live) vs `persisted` (settled) boundary; zero new state machine |
| What "settled" means | 1 evidence | `message.id !== snapshot.streamingId` | The loop already holds the in-flight `assistant`; expose its id. Verified against `runStep`/`runTurn` in `loop.ts` |
| Romanizer shape | 2 coherence | `(text) => Segment[] \| Promise<Segment[]>`, injected | Pure data (no HTML/Svelte), runs once on settle so it may be async/heavy, trivially testable and per-language |
| Reject block memoization (Vercel) | 3 taste | Not adopted | Keeps incremental complexity and forces an incremental-safe romanizer; live romanization is unreadable at ~105 tok/s, so its value does not justify the cost for this product |
| Keep `{@html}` + DOMPurify for now | 3 taste | Keep, run once on settle | Smallest change that captures the full win; component-tree rendering (which would delete both) is a clean later move. Revisit when essays/long replies make the settle-time parse spike visible |
| Reject "deny markdown entirely" | 3 taste | Keep markdown | Tutor replies use lists/bold/code; structure is load-bearing for teaching |
| `showPinyin` generalization | 2 coherence | `showReadings`: renderer toggles ruby visibility; romanizer always produces `reading` | Matches the two-boats "lens" direction; the toggle is presentation, not a romanizer mode |

## The Romanizer contract

```ts
// Language-agnostic, pure, framework-free. Runs once per settled message.
type Segment = { text: string; reading?: string };   // reading absent = render text as-is
type Romanizer = (text: string) => Segment[] | Promise<Segment[]>;

// vocab injects pinyin (sync, pinyin-pro). A future app injects romaji (async, dictionary).
// Default app injects identity: (t) => [{ text: t }].
```

### What was considered and rejected

| Candidate | Why rejected |
| --- | --- |
| `romanize(text) => htmlWithRuby` | Couples the strategy to HTML + a sanitize surface; segments are the smaller, portable contract |
| Injected Svelte component `<Romanized text />` | Framework-coupled and untestable as data; the renderer (not the strategy) should own DOM |
| Incremental/streaming romanizer | Only needed to keep romanization live; refused by the settle-render decision |
| Char-only segmentation (current) | A `Segment` is word-or-char; word-level is required for Japanese/Korean. Chinese can still emit one segment per char |

## Architecture

The render mode is the loop's existing boundary, surfaced to the UI by one new field.

```txt
loop.runTurn:
  turn = [...]                      live (in-flight) messages
  assistant = the message being filled this step   <- snapshot.streamingId
  ...on finish: store.set(message)  -> moves into `persisted` (settled)

snapshot:
  messages: persisted + live        (unchanged)
  streamingId: <id of message being filled> | null   (NEW)

ChatMessage(message):
  isStreaming = message.id === streamingId
  isStreaming ? RAW text node (pre-wrap)      // cheap, updates per token
              : RICH once (memoized by id):   // marked + romanizer + sanitize + {@html}
                  markdown(text)
                  -> walk text nodes -> romanize(textNode) -> Segment[] -> <ruby>
                  -> sanitize -> {@html}
```

The transition fires once per message, exactly when the turn finalizes and the message lands in the store.

```txt
The cascade (one decision, many deletions):

  rich-only-on-settle
    => no per-token marked / annotateHtml / DOMPurify / {@html}   (O(n^2) gone)
    => no throttle, no block memo, no append-stable reasoning
    => romanizer is one-shot
        => romanizer is a pure (text)=>Segment[]
            => romanization is pluggable for ANY language
```

## Call sites: before and after

### 1. Loop snapshot exposes the streaming id

**Before** (`packages/workspace/src/agent/loop.ts`, `ConversationSnapshot` + `snapshot()`):

```ts
export type ConversationSnapshot = {
  messages: AgentMessage[];
  isThinking: boolean;
  isGenerating: boolean;
  error: ConversationError | null;
};
```

**After**:

```ts
export type ConversationSnapshot = {
  messages: AgentMessage[];
  /** The message currently being streamed into, or null between turns. */
  streamingId: string | null;
  isThinking: boolean;
  isGenerating: boolean;
  error: ConversationError | null;
};
```

`snapshot()` derives `streamingId` from the last live message while a step is filling it. `bindAgentConversation` adds a `streamingId` getter alongside `messages`.

**Semantic shift to flag**: `streamingId` is non-null only while a message is actively being filled. A completed in-turn tool step (opensidian/tab-manager) is not the streaming message, so it renders rich mid-turn, which is correct.

### 2. vocab ChatMessage picks the render path

**Before** (`apps/vocab/src/routes/(signed-in)/components/ChatMessage.svelte`): always rich for assistant.

**After**: assistant + `message.id === streamingId` -> raw `<div style="white-space: pre-wrap">{text}</div>`; else `AssistantProse` (rich, once). `ConversationView` passes `streamingId` down.

### 3. annotate becomes romanizer-driven

**Before** (`apps/vocab/src/lib/pinyin/annotate.ts`): `annotateHtml(html)` hardcodes `pinyin-pro` per char.

**After**: a generic `annotate(html, romanizer)` walks text nodes and, for each run, calls `romanizer(text) -> Segment[]` and renders `<ruby>` for segments with a `reading`. vocab supplies a pinyin `Romanizer`; the per-char pinyin logic moves behind that strategy.

## Implementation Plan

### Phase 1 (Build): loop streamingId contract

- [ ] **1.1** Add `streamingId: string | null` to `ConversationSnapshot` and compute it in `snapshot()` (id of the message currently being filled; null otherwise).
- [ ] **1.2** Expose `streamingId` from `bindAgentConversation` (getter).
- [ ] **1.3** Add a loop test: `streamingId` is the in-flight assistant's id during a turn and null after it settles; null between turns.

### Phase 2 (Build): vocab two-path render

- [ ] **2.1** Thread `streamingId` through `ConversationView` -> `ChatMessage`.
- [ ] **2.2** `ChatMessage`: raw `pre-wrap` text when streaming; `AssistantProse` when settled.
- [ ] **2.3** Memoize the settled rich render by message id (settled content is immutable).

### Phase 3 (Build): pluggable romanizer

- [ ] **3.1** Define `Segment` + `Romanizer` (placement in Open Questions).
- [ ] **3.2** Generalize `annotate(html, romanizer)`; move pinyin behind a `pinyinRomanizer: Romanizer`.
- [ ] **3.3** Inject the romanizer into `AssistantProse` (vocab passes pinyin); `showReadings` toggles ruby visibility.

### Phase 4 (Prove): verify

- [ ] **4.1** `bun test packages/workspace/src/agent/` green; loop-repro harness still streams clean.
- [ ] **4.2** Manual: long reply streams raw smoothly, settles to rich+pinyin once, no per-token chug.

### Phase 5 (Remove): delete dead paths

- [ ] **5.1** Remove any now-unused per-token render plumbing and the old `annotateHtml` signature once the romanizer path lands.

## Edge Cases

### Multi-step tool turn (opensidian/tab-manager)

1. A turn streams step 1's assistant, runs tools, streams step 2.
2. Only the actively-filled message matches `streamingId`; completed tool-step messages render rich mid-turn.
3. Per-app renderers (MessageParts) keep owning tool-part rendering; the `streamingId` signal is generic.

### Settle reflow

1. Streaming raw text ends; the message persists.
2. Rich render replaces raw (markdown formatting + ruby line-height) -> one layout shift.
3. Acceptable; reads as "answer ready." A short fade can soften it (Open Questions).

### Very long message

1. Settle runs one parse + romanize over the whole message.
2. At chat lengths this is a small one-time cost; for essays it could be a brief freeze.
3. That is the trigger to revisit component-tree incremental rendering.

### Async romanizer mid-render

1. A future async romanizer (dictionary load) resolves after the message settles.
2. Render shows raw/un-ruby text until it resolves, then upgrades.
3. Expected; one-shot async is fine because it is off the streaming path.

## Open Questions

1. **Snapshot shape: `streamingId` vs a separate `streaming` message field** — RESOLVED: (b), the split.
   - Options: (a) add `streamingId: string \| null`, keep `messages` whole; (b) split `messages` (settled) + `streaming` (the in-flight one).
   - **Resolution**: (b). Grounded in Svelte's reactivity model (DeepWiki `sveltejs/svelte`): `$derived` and a keyed `{#each}` propagate on *referential* change. With (a), `messages` is rebuilt every token (to swap in the fresh-identity streaming clone), so the each re-runs `derived_safe_equal` reconciliation over the whole list per token. With (b), `messages` returns the stable `persisted` reference during a turn, so the settled each is referentially **inert** and only the one `streaming` bubble re-renders. (b) also deletes the `streamingId` marker, the clone-inside-`.map()`, and the UI's `id === streamingId` derivation: "which message is live" becomes a type distinction (a field + a render slot), not a runtime flag in a homogeneous array. It is the same separation the settle-render boundary already wants (`streaming` → raw, `messages` → rich). Cost: a one-time breaking change to `ConversationSnapshot` consumed by three apps, all updated in the same wave.
   - **Shape**: `messages: AgentMessage[]` (settled: persisted + completed in-turn steps) and `streaming: AgentMessage | null` (the message a step is filling, materialized fresh each snapshot, null until it has content). `bindAgentConversation` exposes a `streaming` getter (replaces `streamingId`). Each app renders `{#each messages}` then a single `streaming` slot. Earlier sections of this spec that say `streamingId` are superseded by this resolution.

2. **Where do `Segment`/`Romanizer` live?**
   - Options: (a) `@epicenter/vocab` package; (b) a small shared `@epicenter/...` module if other apps will romanize; (c) local to vocab for now.
   - **Recommendation**: (c) local to vocab now, promote to `@epicenter/vocab` when the package is extracted (aligns with the two-boats lens direction). Do not over-share before a second consumer exists.

3. **Soften the settle reflow?**
   - **Recommendation**: ship without a transition first; add a short fade only if the reflow reads as jarring in practice.

4. **Live render: pure raw vs lightly softened markdown**
   - Options: (a) raw text with `pre-wrap` (shows `**`, `-`); (b) a cheap live softener that strips/handles a few markers.
   - **Recommendation**: (a). Simplest; 1-2s of raw syntax is acceptable. Revisit only if it bothers in use.

## Success Criteria

- [ ] During streaming, the message renders as raw text and updates smoothly (no per-token markdown/ruby work).
- [ ] On settle, the message renders rich (markdown + pinyin) exactly once.
- [ ] `streamingId` is exposed by the loop and bound in Svelte; covered by a loop test.
- [ ] Romanization goes through an injected `Romanizer`; vocab supplies pinyin; nothing app-specific is hardcoded in the renderer.
- [ ] `bun test packages/workspace/src/agent/` green; loop-repro streams clean.
- [ ] No O(n²) render path remains for streaming messages.

## References

- `packages/workspace/src/agent/loop.ts` - `ConversationSnapshot`, `snapshot()`, `runStep`/`runTurn` (streaming message is the in-flight `assistant`).
- `packages/svelte-utils/src/agent-conversation.svelte.ts` - `bindAgentConversation` getters to extend.
- `apps/vocab/src/routes/(signed-in)/components/ConversationView.svelte` - threads snapshot fields to messages.
- `apps/vocab/src/routes/(signed-in)/components/ChatMessage.svelte` - the two-path render lives here.
- `apps/vocab/src/routes/(signed-in)/components/AssistantProse.svelte` - rich pipeline; becomes settle-only and romanizer-driven.
- `apps/vocab/src/lib/pinyin/annotate.ts` - generalize to `annotate(html, romanizer)`; pinyin moves behind a `Romanizer`.
- Consumers of the shared loop to keep green: `apps/opensidian/src/lib/chat/chat-state.svelte.ts`, `apps/tab-manager/src/lib/chat/chat-state.svelte.ts`.
