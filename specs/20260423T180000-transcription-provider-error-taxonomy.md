# Transcription Provider Error Taxonomy

**Date**: 2026-04-23
**Status**: Proposed
**Author**: Surfaced during wellcrafted PR #114 integration

## Overview

Extract provider-specific error handling from each transcription service into its own `defineErrors` taxonomy, and centralize UI translation in a single adapter. Today every cloud provider file (openai, mistral, groq, deepgram, elevenlabs) duplicates ~150 lines of HTTP-status branching and `WhisperingErr` construction. The service layer is tangled with UI copy.

## Motivation

### Current state

Every provider file follows the same pattern:

```ts
// openai.ts — 252 lines, groq.ts — 236, mistral.ts — 135, deepgram.ts — 210
async transcribe(audioBlob, options): Promise<Result<string, WhisperingError>> {
  // 1. Pre-validation (API key, file size) — returns WhisperingErr inline
  // 2. tryAsync the SDK call
  //    catch: narrow via instanceof (openai, groq) OR string-match (mistral) OR no-op
  // 3. if (apiError) { ...huge status-branching block returning WhisperingErr... }
  // 4. Ok(transcription.text)
}
```

Three structural problems:

1. **Every provider duplicates the status→notification mapping.** `401 → "🔑 Authentication Required"`, `429 → "⏱️ Rate Limit Reached"`, etc. The copy is *almost* identical across files, drifts subtly (compare openai's 413 copy to mistral's), and changing UI copy means editing 5 files.

2. **The service layer can't be tested without UI coupling.** You can't call `MistralTranscriptionServiceLive.transcribe()` in a test without pulling in `$lib/result`, `UnifiedNotificationOptions`, and the whole notification schema. The provider's job is "talk to the API"; UI translation is a separate concern it shouldn't own.

3. **Error narrowing is inconsistent and sometimes unsafe.**
   - openai/groq: `instanceof Provider.APIError` with `throw` escape hatch — works, but the `throw` inside `catch` is a code smell (fights the Result model).
   - mistral: `message.includes('401')` — fragile string-matching; breaks if Mistral's SDK changes its error message format. PR #114's `NonNullable<unknown>` constraint also breaks this path (fixed in the companion PR by inlining translation, but the fragility remains).
   - deepgram/elevenlabs: use `HttpServiceLive` which already has typed errors — the *best* of the bunch, but translation to `WhisperingErr` still happens inline per-provider.

### Desired state

Providers return tagged errors. A single adapter translates any provider error into `WhisperingError`.

```ts
// cloud/openai.ts — becomes ~80 lines
//
// Factory-shape convention (applied across all provider error sets):
// - Variants that wrap an underlying error take `{ cause: NonNullable<unknown> }`
//   (compatible with wellcrafted PR #114's Err<E extends NonNullable<unknown>> constraint).
// - Variants carrying extra context add named fields after `cause`.
// - Pre-validation variants (no SDK call made yet) take no args or the minimum
//   context needed for the UI copy.
export const OpenaiError = defineErrors({
  MissingApiKey:       ()                                                   => ({ message: 'OpenAI API key is required' }),
  InvalidApiKeyFormat: ()                                                   => ({ message: 'OpenAI API keys must start with "sk-"' }),
  FileTooLarge:        ({ sizeMb, maxMb }: { sizeMb: number; maxMb: number }) => ({ message: `File size ${sizeMb}MB exceeds ${maxMb}MB limit`, sizeMb, maxMb }),
  Unauthorized:        ({ cause }: { cause: OpenAI.APIError })              => ({ message: cause.message ?? 'OpenAI rejected the API key', cause }),
  RateLimit:           ({ cause }: { cause: OpenAI.APIError })              => ({ message: cause.message, cause }),
  BadRequest:          ({ cause }: { cause: OpenAI.APIError })              => ({ message: cause.message, cause }),
  // ...one variant per HTTP class the OpenAI SDK distinguishes
  Connection:          ({ cause }: { cause: OpenAI.APIError })              => ({ message: cause.message, cause }),
  Unexpected:          ({ cause }: { cause: NonNullable<unknown> })         => ({ message: extractErrorMessage(cause), cause }),
});
export type OpenaiError = InferErrors<typeof OpenaiError>;

export const OpenaiTranscriptionServiceLive = {
  async transcribe(audioBlob, options): Promise<Result<string, OpenaiError>> {
    if (!options.apiKey) return OpenaiError.MissingApiKey();
    if (!options.apiKey.startsWith('sk-')) return OpenaiError.InvalidApiKeyFormat();

    const sizeMb = audioBlob.size / (1024 * 1024);
    if (sizeMb > MAX_FILE_SIZE_MB) {
      return OpenaiError.FileTooLarge({ sizeMb, maxMb: MAX_FILE_SIZE_MB });
    }

    return tryAsync({
      try: () => new OpenAI({...}).audio.transcriptions.create({...}).then(r => r.text.trim()),
      catch: (error) => {
        // `error: unknown` from the `catch` — narrow to NonNullable before dispatching.
        // `throw null` is legal JS; reject it explicitly rather than casting around it.
        if (error == null) return OpenaiError.Unexpected({ cause: new Error('Non-value thrown from OpenAI SDK') });
        if (!(error instanceof OpenAI.APIError)) return OpenaiError.Unexpected({ cause: error });
        switch (error.status) {
          case 401: return OpenaiError.Unauthorized({ cause: error });
          case 429: return OpenaiError.RateLimit({ cause: error });
          case 400: return OpenaiError.BadRequest({ cause: error });
          // ...
          default:  return OpenaiError.Unexpected({ cause: error });
        }
      },
    });
  },
};
```

```ts
// cloud/error-adapter.ts — single source of truth for UI copy
export function transcriptionErrorToWhisperingErr(
  err: OpenaiError | GroqError | MistralError | DeepgramError | ElevenlabsError,
) {
  switch (err.name) {
    case 'MissingApiKey':
      return WhisperingErr({
        title: '🔑 API Key Required',
        description: `Please enter your ${providerFor(err)} API key in settings.`,
        action: { type: 'link', label: 'Add API key', href: '/settings/transcription' },
      });
    case 'Unauthorized':
      return WhisperingErr({
        title: '🔑 Authentication Required',
        description: 'Your API key appears to be invalid or expired.',
        action: { type: 'link', label: 'Update API key', href: '/settings/transcription' },
      });
    case 'RateLimit':
      return WhisperingErr({
        title: '⏱️ Rate Limit Reached',
        description: err.message ?? 'Too many requests. Please try again later.',
        action: { type: 'more-details', error: err.cause },
      });
    // ...one case per tagged variant; shared variants (Unauthorized, RateLimit) get one case each
  }
}
```

Call sites in `$lib/query/actions.ts` (or wherever transcription is kicked off) apply the adapter at the UI boundary:

```ts
const { data, error } = await services.transcription.openai.transcribe(blob, opts);
if (error) return rpc.notify.error(transcriptionErrorToWhisperingErr(error));
```

## Design

### The two-layer split

```
┌─────────────────────────────────┐
│   UI layer (query/actions)      │   transcriptionErrorToWhisperingErr(err)
├─────────────────────────────────┤
│   Adapter layer                 │   one file, one switch, all UI copy lives here
├─────────────────────────────────┤
│   Provider layer                │   returns Result<string, ProviderError>
│   (cloud/openai.ts, etc.)        │   no WhisperingErr, no UnifiedNotificationOptions
└─────────────────────────────────┘
```

**Decoupling constraint (load-bearing — enforce via ESLint if possible):**

The provider file AND its colocated error set must not import anything from:
- `$lib/result` (WhisperingErr, WhisperingError, WhisperingWarningErr)
- `$lib/services/notifications/*` (UnifiedNotificationOptions, notification types)
- `$lib/components/*` (UI primitives)

Only the adapter layer may import from those. This is what makes providers unit-testable without UI coupling — the claim collapses if a provider's error types transitively pull in notification schemas through `WhisperingError`.

Provider files may still import from:
- `wellcrafted/*` (result, error primitives)
- SDKs (`openai`, `@mistralai/mistralai`, `groq-sdk`, etc.)
- `$lib/services/http` (already provider-agnostic)
- `$lib/services/transcription/utils` (getAudioExtension, etc.)

### Per-provider error sets

Each provider defines error variants that reflect what *that provider* actually distinguishes, not a lowest-common-denominator set:

- **openai, groq:** SDK exposes `Provider.APIError` with `status`. Variants: `Unauthorized | RateLimit | BadRequest | NotFound | PermissionDenied | UnprocessableEntity | PayloadTooLarge | UnsupportedMediaType | ServiceUnavailable | Connection | Unexpected`.
- **mistral:** SDK throws raw errors today. Either use the string-matching fallback inside the `catch` to classify into tagged variants (ugly but contained), OR use `HttpServiceLive` + typed status codes like deepgram does. The latter is better — separate refactor.
- **deepgram, elevenlabs:** already use `HttpServiceLive`. Lift their inline error handling into their own `defineErrors` sets.

### Where shared variants go

Don't create a root `TranscriptionError` union prematurely. Start with per-provider sets. After all 5 are migrated, look at the adapter's `switch` — if 80% of cases across providers collapse to identical WhisperingErr output (they will, for auth/rate-limit/connection), *then* promote a shared `HttpProviderError` base set that providers extend.

Do this second, not first. Premature unification locks in assumptions before we see the real shape.

### File organization

```
apps/whispering/src/lib/services/transcription/cloud/
├── error-adapter.ts          # NEW — transcriptionErrorToWhisperingErr
├── openai.ts                 # OpenaiError + OpenaiTranscriptionServiceLive
├── groq.ts                   # GroqError + Groq...
├── mistral.ts                # MistralError + Mistral...
├── deepgram.ts               # DeepgramError + Deepgram...
└── elevenlabs.ts             # ElevenlabsError + Elevenlabs...
```

Colocate each `XxxError` in its provider file (like `FsError` lives in `fs.ts`) — it's part of the provider's public API.

## Migration plan

Provider-by-provider, ordered by **ROI** (biggest pain first), not by cleanliness:

1. **mistral** (highest ROI — small file, *current* pain). Fragile `message.includes('401')` string-matching breaks silently if the SDK rewords its error messages, and it was the blast-radius site for wellcrafted PR #114's `NonNullable<unknown>` constraint. Smallest file (135 lines), biggest payoff. Two sub-options:
   - **(a)** Lift Mistral's transcription call onto `HttpServiceLive` like deepgram does — gives typed status codes, kills the string-match. Cleanest end state.
   - **(b)** Keep the SDK call; move string-match classification *inside* the `catch` to produce `MistralError` tagged variants. The smell is contained to one function instead of leaking into the caller.
   Default to (a) unless the Mistral SDK adds something `HttpServiceLive` can't (streaming, multipart oddities).
2. **openai** (medium — SDK exposes `OpenAI.APIError` with `.status`). Biggest file (252 lines) but the structure is clean once `OpenaiError` is defined. Ships the `error-adapter.ts` shared surface; deepgram/elevenlabs plug into it later.
3. **groq** (mirrors openai — same SDK shape). After step 3, the adapter's switch cases for openai + groq should look near-identical. **This is the decision point** for promoting a shared `HttpProviderError` base set. Don't do it earlier.
4. **deepgram** (already HTTP-typed — lowest ROI but trivial). Lift its inline `WhisperingErr` construction into a `DeepgramError` set + adapter case.
5. **elevenlabs** (smallest, same treatment as deepgram).

Each provider is an independent PR. Adapter grows incrementally. No big-bang rewrite.

### Test plan per step

For each migrated provider:
- Unit test the provider with a mocked SDK/HTTP layer — assert correct tagged error for each status path. Doesn't require `$lib/result` imports. **This is the payoff.**
- Snapshot test the adapter's output for each variant.
- Keep the existing integration test (if any) green on the action-layer call site.

## Open questions

1. **Adapter location.** `cloud/error-adapter.ts` (beside providers) or `$lib/query/transcription-errors.ts` (with the call sites)? The adapter is call-site code, not service code — arguably belongs closer to `rpc.notify`. Decide during step 1.
2. **Pre-validation errors (MissingApiKey, FileTooLarge).** These aren't really runtime errors — they're input validation. Option: hoist to a pre-check layer outside the service. Option: keep them as tagged variants (simpler, matches today's shape). Default: keep as variants.
3. **Provider identity in the error.** The adapter needs to know "which provider" for copy like "Please enter your *Mistral* API key." Either stamp `provider: 'openai' | ...` on every variant (explicit), or dispatch on the tag's origin (the adapter's `switch` already knows). Explicit is safer but adds fields; implicit is cleaner. Revisit after 2 providers are migrated.
4. **Self-hosted / local providers.** `speaches`, `whispercpp`, `moonshine`, `parakeet` have their own error shapes. Out of scope for this spec — likely a second taxonomy once cloud is done.

## Non-goals

- Changing the UI copy. The new adapter should emit strings that match today's notifications byte-for-byte at first. Copy iteration is a separate pass.
- Merging provider SDKs. Each provider keeps its own SDK client.
- Replacing `WhisperingErr`. It remains the notification envelope; this spec just moves its construction to one place.

## Expected outcome

- Each `cloud/*.ts` drops from 135–252 lines to ~60–100 lines.
- One `error-adapter.ts` (~150 lines) owns all UI copy for transcription failures.
- Adding a 6th cloud provider = define its `XxxError` + add 1–N cases to the adapter. No duplicated UI plumbing.
- Providers become unit-testable without UI dependencies.
- The fragile string-match in mistral goes away (either into a contained classification `switch` or into `HttpServiceLive`-typed handling).
