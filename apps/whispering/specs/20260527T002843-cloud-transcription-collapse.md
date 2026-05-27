# Cloud transcription provider collapse

## Status

Draft. Handoff-ready prompt at bottom.

## Context

This spec is a follow-on to two commits that collapsed the **local** transcription engines:

- `165c10b03` refactor(whispering): consolidate local model catalogs in $lib/constants
- `b662724a4` refactor(whispering): inline local engine dispatch in transcribe.ts

The local commits worked because main had already moved local dispatch into a single typed Tauri command (`transcribe_recording(recording_id, config: TranscribeRequest)`), making the JS-side per-engine service files thin shims that did preflight + one Tauri call. Three files became one switch.

**Read this carefully before assuming the same pattern applies here:** cloud provider service files are not thin shims. Each contains real HTTP work — SDK setup, request shaping, error mapping by status code. The 1:1 application of the local pattern would discard meaningful provider-specific behavior. The win is narrower and more selective.

## What is actually duplicated (and what isn't)

```
File sizes today:
  cloud/openai.ts     180  } 
  cloud/groq.ts       166  } Same shape (OpenAI SDK pattern)
  cloud/mistral.ts    152  } 
  cloud/deepgram.ts   173    Own SDK
  cloud/elevenlabs.ts  67    Own SDK, minimal error handling
  self-hosted/speaches.ts 176 Raw HTTP, arktype validation, friendly error messages
                      ---
                      914  total
```

### Duplicated (target this)

**OpenAI / Groq / Mistral** all use OpenAI-shaped SDKs (`groq-sdk` and `mistralai` extend the OpenAI SDK contract). Compare openai.ts:85-180 with groq.ts:77-167 with a 3-way diff — the differences are:

```
            openai          groq                       mistral
SDK         OpenAI          Groq                       Mistral (TBD)
ApiKey      'sk-'           'gsk_' | 'xai-'            'mistral-' (TBD)
MaxSizeMb   25              25                         25 (TBD)
Errors      +PayloadTooLarge,+UnsupportedMediaType     (TBD)
```

Everything else (file-size guard, File construction, `tryAsync` body, status→error switch, `customFetch` plumbing, `dangerouslyAllowBrowser`, `audio.transcriptions.create` call shape) is mechanical repetition. This is the target.

### Not duplicated (leave alone)

- **ElevenLabs** uses `client.speechToText.convert` with diarization options; entirely different request shape; error handling is minimal (one `Unexpected`). 67 lines, already lean.
- **Deepgram** uses its own SDK with its own error taxonomy.
- **Speaches** is self-hosted: raw HTTP, arktype response validation, friendly error messages tuned for user-facing UI, no API-key validation (custom endpoint). Different value proposition; do not factor against the SDK-shaped providers.

Forcing all six under one adapter would either lose meaningful differences or grow the adapter into a god-helper with branches for each. Don't.

## Proposed shape

### 1. Add `cloud/openai-shaped.ts` adapter

```ts
// $lib/services/transcription/cloud/openai-shaped.ts
//
// Wraps the OpenAI / Groq / Mistral pattern: an OpenAI-SDK-compatible
// client, an API-key prefix list, and a max file size. Owns the
// file-size check, the File construction, the SDK call, and the
// status -> error mapping.
//
// Used by openai.ts, groq.ts, mistral.ts. Do not extend this to
// providers that don't conform to the OpenAI SDK shape.

import type { OpenAI } from 'openai';

type OpenAIShapedClient = {
  audio: { transcriptions: { create: (opts: ...) => Promise<{ text: string }> } };
};

export type OpenAIShapedOptions = {
  prompt: string;
  temperature: string;
  outputLanguage: string;
  apiKey: string;
  modelName: string;
  baseURL?: string;
};

export type OpenAIShapedConfig = {
  // Provider-friendly name in error messages ("OpenAI", "Groq", "Mistral").
  providerLabel: string;
  // Construct an SDK client. Caller owns the SDK choice.
  createClient: (opts: { apiKey: string; baseURL?: string }) => OpenAIShapedClient;
  // Class to instanceof-check the SDK's APIError shape.
  APIErrorCtor: typeof OpenAI.APIError;
  // Prefixes a valid API key may start with (empty if no format check).
  apiKeyPrefixes: readonly string[];
  // Provider's documented max upload size in MB.
  maxFileSizeMb: number;
};

export const CloudOpenAIShapedError = defineErrors({
  MissingApiKey: ({ providerLabel }: { providerLabel: string }) => ({...}),
  InvalidApiKeyFormat: ({ providerLabel, prefixes }: { providerLabel: string; prefixes: readonly string[] }) => ({...}),
  FileTooLarge: ({ sizeMb, maxMb }: { sizeMb: number; maxMb: number }) => ({...}),
  FileCreationFailed: ({ cause }: { cause: unknown }) => ({...}),
  BadRequest, Unauthorized, PermissionDenied, NotFound,
  PayloadTooLarge, UnsupportedMediaType, UnprocessableEntity,
  RateLimit, ServiceUnavailable, Connection, Unexpected,
});

export async function openAIShapedTranscribe(
  audioBlob: Blob,
  options: OpenAIShapedOptions,
  config: OpenAIShapedConfig,
): Promise<Result<string, CloudOpenAIShapedError>> {
  // 1. API-key format check (skip if baseURL set or prefixes empty)
  // 2. File-size guard
  // 3. File construction via getAudioExtension
  // 4. config.createClient(...).audio.transcriptions.create(...)
  // 5. status switch -> tagged error
}
```

Each provider file becomes ~30-40 lines (down from 150-180):

```ts
// openai.ts
import { OpenAI } from 'openai';
import { openAIShapedTranscribe, type OpenAIShapedOptions } from './openai-shaped';

export const OpenaiTranscriptionServiceLive = {
  transcribe: (audioBlob: Blob, options: OpenAIShapedOptions) =>
    openAIShapedTranscribe(audioBlob, options, {
      providerLabel: 'OpenAI',
      createClient: ({ apiKey, baseURL }) => new OpenAI({ apiKey, baseURL, dangerouslyAllowBrowser: true, fetch: customFetch }),
      APIErrorCtor: OpenAI.APIError,
      apiKeyPrefixes: ['sk-'],
      maxFileSizeMb: 25,
    }),
};
```

### 2. Decide on error type strategy (pick one before coding)

**Option A — single shared error**: drop `OpenaiError` / `GroqError` / `MistralError`. Callers and `dispatchCloudTranscription` see `CloudOpenAIShapedError` from these three. Provider identity carried only in the message (`"OpenAI API key is required"`).

- Pro: one error family for three providers. Fewer types to wire through Result generics in `operations/transcribe.ts`.
- Con: error.name no longer tells you which provider failed without parsing the message. If anywhere matches on `error.name === 'OpenaiError.RateLimit'`, breakage.

**Option B — provider-tagged shared error**: `CloudOpenAIShapedError.RateLimit({ provider: 'OpenAI', cause })`. Same variants, but every variant carries a `provider` field.

- Pro: keeps provider identity machine-readable.
- Con: every callsite that constructs the error pays for the tag. The provider field is rarely consumed.

**Option C — per-provider re-export thin alias**: keep `OpenaiError = CloudOpenAIShapedError` as a re-export from each file, so external consumers (analytics, reporting) keep importing the same name but it points at the shared type.

- Pro: no API churn for consumers.
- Con: three names for one type can confuse readers grepping for the error definition.

**Recommendation**: Option A. Grep for `OpenaiError\.` / `GroqError\.` / `MistralError\.` usages before deciding — if zero callers pattern-match on `error.name`, A is cleanest. If anyone does, fall back to C.

### 3. Optional: collapse self-hosted `speaches` into the same family?

Speaches uses an OpenAI-compatible Whisper API at a user-provided URL. It does NOT use the OpenAI SDK — it uses raw `HttpServiceLive.post` + arktype validation. The error taxonomy is different (friendly messages) and there's no API-key gate.

**Recommendation**: leave speaches.ts alone. Its value is that it gives users control over server-side errors with human-readable messages. Forcing it into the SDK-shaped adapter would be a regression in UX for self-hosted users.

## Out of scope

- The `dispatchCloudTranscription` switch in `operations/transcribe.ts`. Each case extracts provider-specific settings + deviceConfig fields and passes them as the `options` arg. There is no clean way to unify this without violating the "services don't access settings directly" rule (CLAUDE.md). The switch stays.
- Inlining cloud services into `transcribe.ts`. Cloud services are real HTTP work, not shims. They earn their own files.
- Adding new providers. Spec is a refactor, not a feature.

## Verification gate

- `bun run typecheck` passes
- Manual smoke test: OpenAI / Groq transcribe still works (sign in, record, transcribe; expect text back)
- Error path test: temporarily set an invalid API key, transcribe, confirm the error message reads the same as before (provider name + reason)
- Grep `OpenaiError\.\|GroqError\.\|MistralError\.` returns no production hits beyond their own files

## Estimated impact

```
Before (5 SDK-shape providers + 1 self-hosted): ~840 lines
After  (openai-shaped helper + 3 thin providers + 1 self-hosted + 2 untouched): ~520 lines
Net:   -320 lines, one new file, no behavior change
```

If only OpenAI + Groq fit cleanly (Mistral SDK turns out non-conforming), estimate drops to -200 lines.

---

## Handoff prompt (copy-paste to a fresh agent)

> Apply spec `apps/whispering/specs/20260527T002843-cloud-transcription-collapse.md`. This is a continuation of two recent commits (`165c10b03`, `b662724a4`) that collapsed the *local* transcription engines. The cloud spec is more selective — read its "What is actually duplicated (and what isn't)" section first.
>
> Concretely:
>
> 1. Verify that `apps/whispering/src/lib/services/transcription/cloud/mistral.ts` uses an OpenAI-SDK-shaped client (look for `audio.transcriptions.create`). If yes, it's a target. If not, it stays out of scope.
> 2. Create `apps/whispering/src/lib/services/transcription/cloud/openai-shaped.ts` per the spec's "Proposed shape" §1. The shared error type goes here.
> 3. Rewrite `openai.ts`, `groq.ts`, and (if §1 confirms) `mistral.ts` to ~30-40 lines each, delegating to the helper.
> 4. Decide error type strategy. Default is Option A (single shared error). Before deciding, grep `OpenaiError\.|GroqError\.|MistralError\.` across `apps/whispering/src` — if there are no callsite usages, choose A and delete the per-provider error types. If there are, choose C.
> 5. Do NOT touch `elevenlabs.ts`, `deepgram.ts`, or `speaches.ts`. They have different shapes; the spec is explicit about leaving them alone.
> 6. Do NOT inline the cloud dispatch into `transcribe.ts`. The cloud services are real HTTP work; the switch stays.
> 7. Commit in two waves matching the local pattern: wave 1 introduces the helper alongside, wave 2 migrates each provider and removes any duplicated definitions.
> 8. `bun run typecheck` from `apps/whispering` must pass after each wave.
> 9. Verification gate: see spec.
