# Zhongwen

Bilingual Chinese-English chat app for learning Mandarin. Users ask questions in English; the AI responds with mixed English and Chinese. The client automatically annotates Chinese characters with pinyin using `<ruby>` tags. The system prompt tells the AI to never include pinyin itself.

## How it works

**Chat over a synced doc (doc-as-wire)**: Each conversation's transcript lives in its own synced Yjs child doc, a `Y.Array('messages')` of append-only `Y.Map`s (one `Y.Text` of content per message). The client sends by appending a user message map and POSTing a kickoff to `${APP_URLS.API}/ai/chat/doc` with the conversation's `guid`, a fresh `generationId`, and the provider/model/system prompt (no message history in the body). The server holds that request open for the whole turn and streams assistant tokens straight into the same doc as a sync peer; the UI renders from a doc observer, so persistence, multi-device live view, and refresh-resume are consequences of one source of truth rather than separate features. Stop is aborting the kickoff fetch. The doc layout is owned by `@epicenter/workspace/ai` (`chat-doc.ts`); the server actor by `packages/server/src/ai/doc-generation.ts`.

**Markdown + pinyin**: Assistant messages are parsed with `marked` (GFM, breaks enabled) into HTML, then `annotateHtml()` in `src/lib/pinyin/annotate.ts` walks text nodes (splitting on HTML tags via regex) and wraps CJK runs with `<ruby>` pinyin tags using `pinyin-pro`. Output is sanitized with DOMPurify (allowing ruby/rt/rp), memoized via `$derived` in `AssistantMessagePart.svelte`, and rendered via `{@html}` inside `<div class="prose prose-sm">`.

**Workspace state**: `createZhongwen()` in `zhongwen.ts` is the shared isomorphic model. It defines `epicenter-zhongwen`, the `conversations` table (the cheap list: title, provider, model, timestamps), the `showPinyin` KV value, the app action registry, and a `conversationDocs` disposable cache that mints each conversation's transcript child doc by `zhongwenConversationDocGuid(id)`. Transcripts are not a table; they are per-conversation child docs. `openZhongwenBrowser()` attaches encrypted local storage and collaboration around the root doc and around each open transcript doc.

```txt
createWorkspace()
  -> createZhongwen()
    -> openZhongwenBrowser()
    -> zhongwen() (project mount)
```

**UI state**: `createChatState()` in `src/routes/(signed-in)/chat/chat-state.svelte.ts` is a Svelte 5 factory for the live chat UI. The sidebar list reads the `conversations` table; only the active conversation opens its transcript doc (IDB + websocket). Messages render from a doc observer. Liveness is derived from update recency, never stored: a trailing assistant message with no `finish` and recent updates is streaming, the same message gone quiet past a ~3s grace window is interrupted (offer retry), and the terminal outcome is the message's write-once `finish` key.

**Auth**: Google OAuth through the shared Epicenter auth/session path. The browser runtime is built through `createSession`, so storage and sync only mount after a signed-in identity provides `ownerId`, `keyring`, and WebSocket transport functions.

**Providers**: `src/routes/(signed-in)/chat/providers.ts` maps provider names to model lists imported from `@tanstack/ai-{openai,gemini,grok}`. Default is Gemini. Provider/model is per-conversation and configurable in the UI.

## File map

```
src/
  routes/
    (signed-in)/+page.svelte          # Main layout: sidebar + chat area + pinyin toggle
    +layout.svelte         # Root layout with Toaster
    +layout.ts             # SSR disabled (CSR only)
  lib/
    platform/auth/auth.ts  # OAuth auth client
    session.ts             # createSession + openZhongwenBrowser singleton
    pinyin/
      annotate.ts          # annotateHtml(): CJK detection and ruby annotation
  routes/(signed-in)/
    chat/
      chat-state.svelte.ts # Reactive multi-conversation state
      providers.ts         # Provider/model config from TanStack AI packages
      system-prompt.ts     # AI instructions (mix languages, no pinyin, simplified only)
    components/
      ChatMessage.svelte       # Renders one ChatDocMessage; delegates assistant text to AssistantMessagePart
      AssistantMessagePart.svelte # Markdown parse + pinyin annotate + DOMPurify, memoized via $derived
      ChatInput.svelte         # Textarea + send button, Enter to submit
      ZhongwenSidebar.svelte   # Sidebar conversation list with create/switch
zhongwen.ts                    # Shared isomorphic model (tables, KV, conversation child docs)
zhongwen.browser.ts            # openZhongwenBrowser runtime wiring
```

## Key decisions

- The conversation list lives in the root workspace doc (`conversations` table); each transcript lives in its own synced child doc. There is no `chatMessages` table.
- The doc is the wire: the server streams a turn by appending to the transcript doc as a sync peer, so there is no SSE transport and no dual write to reconcile.
- Liveness and terminal outcome are not stored as a status field. Liveness is derived from update recency; the outcome is the single write-once `finish` key.
- SSR is disabled; the app is CSR-only.
- The system prompt forbids pinyin in AI responses so the client can control annotation rendering and toggle visibility.

## Scripts

```sh
bun run dev        # Start dev server
bun run build      # Production build
bun run preview    # Preview production build
bun run typecheck  # svelte-check
```
