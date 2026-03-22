# Zhongwen — Continuation Prompts

Copy-paste these into a new conversation to pick up where we left off. Each section is self-contained with context from audits already performed.

## What's been done

Branch `feat/zhongwen` has these commits on top of `main`:

1. `feat(zhongwen): scaffold bilingual Chinese-English chat app` — full SvelteKit app with TanStack AI streaming, multi-provider, pinyin annotation, Google OAuth
2. `feat(zhongwen): add markdown rendering with pinyin annotation` — `marked` + `annotateHtml()` pipeline, `PinyinText.svelte` removed
3. `fix(zhongwen): sanitize markdown output and memoize pinyin annotation` — DOMPurify (allowing ruby/rt/rp), `$derived` memoization in `AssistantMessagePart`
4. `refactor(zhongwen): reactive handle sync, validate provider, rename getter` — provider validation, `conversations` -> `conversationHandles`
5. `fix(zhongwen): revert $effect to imperative reconcileHandles` — `$effect` can't run at module level
6. `refactor(zhongwen): reduce indirection in chat-state` — `metadata` `$derived` replaces 6 `.find()` calls, `reconcileHandles()` inlined, pass-through getters removed
7. `refactor(zhongwen): remove dead code and update README` — `segmentText`, `status` state, `ChatClientState` import removed
8. `chore(zhongwen): remove unused deps and exports` — removed `better-auth`, `wellcrafted` from direct deps, removed `AVAILABLE_PROVIDERS`

---

## Auth guard and error recovery (critical)

Audit found: no auth guard on chat UI, unauthenticated users can send messages and get opaque 401s, `"Bearer undefined"` sent as header, SSE auth errors don't reconcile auth state.

```
Fix auth flow in apps/zhongwen:

1. Gate the chat area in +page.svelte behind authState.status === 'signed-in'. Show a sign-in prompt when signed out.
2. In chat-state.svelte.ts, omit the Authorization header entirely when tokenStore.get() returns undefined instead of sending "Bearer undefined".
3. Add an IME composition guard on enter in ChatInput.svelte — check !e.isComposing before submitting (critical for CJK input). Tab-manager already does this at ChatInput.svelte:67.
4. Wire handle.error display to detect 401 errors and call authState.checkSession() so the UI transitions to signed-out.
5. Add a retry button to the error display that calls handle.reload().

Reference: tab-manager uses authState.fetch wrapper (chat-state.svelte.ts:223) for lazy token injection. Consider adopting the same pattern.
Commit incrementally.
```

## Auto-scroll and UX polish (critical)

Audit found: zero scroll management, no typing indicator, no error dismissal, `h-screen` broken on mobile Safari.

```
Fix UX issues in apps/zhongwen:

1. Add auto-scroll to the chat message list. Scroll to bottom when new messages arrive and during streaming. Don't force-scroll if the user has manually scrolled up. Tab-manager's Chat.List from @epicenter/ui already has UseAutoScroll — check if it's wired up, and if not, wire it.
2. Replace h-screen with h-dvh in +page.svelte (line 20) for mobile browser compatibility.
3. Add a typing/loading indicator in the message area when handle.isLoading is true (tab-manager uses loading dots).
4. Make the error display dismissible with a retry button (handle.reload() exists but isn't wired to UI).
5. Add a "Enter to send, Shift+Enter for new line" hint below the textarea in ChatInput.

Commit incrementally.
```

## Accessibility (warning)

Audit found: zero ARIA attributes across the entire app, no focus management.

```
Fix accessibility in apps/zhongwen:

1. Pinyin toggle button: add aria-pressed={showPinyin} and aria-label="Toggle pinyin annotations"
2. ConversationList: add aria-current="page" on the active conversation button, aria-label="New conversation" on the "+ New" button
3. Chat message area: add aria-live="polite" region so screen readers announce new messages
4. Focus management: move focus to textarea after conversation switch (chatState.switchTo) and after sending a message
5. ChatInput: add aria-label="Message input" to the textarea

Commit.
```

## Adopt tab-manager patterns (improvement)

Comparison audit found these tab-manager patterns worth adopting in zhongwen. Not all are needed — pick what makes sense.

```
Review these tab-manager patterns and adopt the relevant ones in apps/zhongwen:

SHOULD ADOPT:
1. IME composition guard: tab-manager's ChatInput.svelte:67 checks !e.isComposing before submitting on Enter. Critical for a CJK app.
2. Submission timeout: tab-manager sets a 60s timer when status === 'submitted'. If no stream begins, it errors. Prevents hung requests.
3. Error dismissal: tab-manager has dismissedError state + ChatErrorBanner with retry/dismiss buttons.
4. onError stream logging: tab-manager logs stream errors with conversationId for debugging.

CONSIDER ADOPTING:
5. Thinking parts: tab-manager renders part.type === 'thinking' in a collapsible ThinkingPart.svelte. If providers return thinking content, zhongwen silently drops it.
6. Status tracking: tab-manager exposes full ChatClientState ('ready'|'submitted'|'streaming'|'error') for richer UI states. zhongwen only has isLoading boolean.
7. Credits exhaustion: tab-manager detects 402 errors and shows a billing upgrade path.

PROBABLY NOT NEEDED:
8. Tool calls / approval flow — zhongwen is a language learning chat, no workspace tools.
9. Y.Doc persistence — separate concern, handle in the persistence prompt below.
10. Conversation branching — overkill for this app.

SHARED CODE EXTRACTION:
11. providers.ts is identical between both apps. Extract to a shared package or @epicenter/constants.
12. tab-manager's MessageParts.svelte text rendering path (marked.parse + prose prose-sm) is the same as zhongwen's AssistantMessagePart. The non-text part stubs are generic. Consider extracting to @epicenter/ui.
13. tab-manager has unsanitized {#html marked.parse()} — same XSS vuln we fixed in zhongwen. Port the DOMPurify fix there too.

Implement what you adopt, commit incrementally.
```

## Dead code — conversation lifecycle (suggestion)

Audit found: `deleteConversation` on chatState and `reload()`, `stop()`, `rename()` on handles are defined but no UI calls them.

```
Wire up unused conversation lifecycle methods in apps/zhongwen:

1. Add a delete button to each conversation in ConversationList.svelte (chatState.deleteConversation exists but has no UI)
2. Add a rename interaction (inline edit or dialog) for conversations (handle.rename() exists)
3. Add a regenerate button below assistant messages (handle.reload() exists)
4. Add a stop button visible during streaming (handle.stop() exists)

Or if these features aren't needed yet, remove the dead methods to reduce surface area. Don't leave code that looks wired up but isn't.
Commit.
```

## Streaming performance deep-dive

```
Profile the markdown + pinyin pipeline in apps/zhongwen during a long streaming response:
1. Does $derived.by in AssistantMessagePart recompute on every streaming token? It should only recompute when part.content changes — verify this.
2. For a 2000-character Chinese response, measure how long annotateHtml() takes. Is it under 16ms (one frame)?
3. Would it help to defer pinyin annotation until streaming completes and only show raw markdown during streaming?
4. Check if marked.parse() is the bottleneck or if pinyin-pro's dictionary lookup is.
Propose and implement if needed. Commit.
```

## Conversation persistence

```
Conversations in apps/zhongwen are in-memory only. Implement localStorage persistence:
1. Save conversation metadata (id, title, provider, model, timestamps) to localStorage
2. Save message history per conversation
3. Restore on page load
4. Add a "clear all" button
Follow the createPersistedState pattern from packages/svelte-utils/src/persisted-state.svelte.ts.
Tab-manager uses Y.Doc for this, but localStorage is appropriate for zhongwen's simpler needs.
Commit incrementally.
```

## Extract shared chat utilities

```
Both apps/zhongwen and apps/tab-manager use nearly identical code in several places:

1. providers.ts — identical PROVIDER_MODELS, DEFAULT_PROVIDER, DEFAULT_MODEL. Extract to @epicenter/constants or a new @epicenter/ai-config package.
2. Markdown rendering — both use marked.parse() + prose prose-sm. zhongwen adds DOMPurify + pinyin. Consider a shared sanitized markdown renderer in @epicenter/ui.
3. DOMPurify — tab-manager has the same unsanitized {#html marked.parse()} XSS vulnerability. Port the fix.
4. MessageParts dispatch — tab-manager's text/thinking/tool-call/image part routing is app-agnostic. Could be a shared component.

Only extract if both apps would actually import it. Don't extract for hypothetical reuse.
```

## System prompt iteration

```
Review apps/zhongwen/src/lib/chat/system-prompt.ts:
1. Test with actual API calls — does the AI follow the "no pinyin" instruction reliably across providers?
2. Does it handle edge cases: user asks for traditional characters, user pastes Japanese kanji, user asks for grammar explanations?
3. Should the prompt adapt based on conversation history length (beginner vs advanced)?
4. Compare prompt engineering across OpenAI vs Anthropic vs Gemini — do they need provider-specific tuning?
```

## Security hardening

```
Review apps/zhongwen for security:
1. DOMPurify config — should we restrict allowed tags more tightly? Currently ADD_TAGS: ['ruby', 'rt', 'rp'] adds on top of defaults.
2. CSP headers — is there a Content-Security-Policy that blocks inline scripts as defense-in-depth?
3. API key exposure — are there any client-side env vars leaking?
4. Rate limiting — is the /ai/chat endpoint rate-limited to prevent abuse?
5. tab-manager has the same unsanitized marked vulnerability — fix it there too.
```

## Squash before merge

```
The feat/zhongwen branch has fix commits that correct earlier commits in the same branch.
Before merging to main, consider squashing into logical units:
1. One commit for the full app scaffold (including markdown + pinyin + DOMPurify)
2. One commit for the refactoring (indirection cleanup, dead code removal)
This keeps main history clean. Use interactive rebase.
```
