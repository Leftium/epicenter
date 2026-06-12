# Whispering Custom Backend Profiles

**Date**: 2026-06-12
**Status**: Draft
**Owner**: Braden
**Branch**: (future; builds on the providers clean break)

## One Sentence

Users define named OpenAI-compatible backend profiles (name, endpoint, API key,
default model), and a transformation step targets a profile instead of the single
global Custom slot.

## Motivation

The product promise is "use OpenAI, and bring as many OpenAI-compatible backends
as you want." Today the app supports exactly one custom backend globally
(`providers.custom.endpoint`). The per-step `customBaseUrl` deleted by the
endpoint consolidation was, awkwardly, the only multi-backend support the app
ever had: a user running Ollama and LM Studio side by side could point different
steps at different servers. Named profiles are the deliberate version of that
accident.

## Design Sketch (to be hardened before implementation)

```txt
deviceConfig (device-bound: profiles carry secrets)
  providers.custom.profiles   Array<{
    id: string                 nanoid, referenced by steps
    name: string               user label, e.g. "LM Studio"
    endpoint: string
    apiKey: string             '' when the server needs none
    defaultModel: string
  }>                           stored as one JSON entry (createPersistedMap
                               supports arbitrary arktype schemas per key)

transformationSteps (flat row)
  customProfileId: field.string()   '' = first profile / legacy single slot

editor
  Provider select grows a "Custom backends" group listing profiles by name;
  managing profiles (add/edit/delete) lives on the api-keys settings page.

transform.ts
  Custom entry resolves { endpoint, apiKey, model } from the profile;
  a step pointing at a deleted profile fails with a named error.
```

## Open Questions

1. Does the single `providers.custom.*` record stay as a fallback, or do
   profiles replace it entirely (first-run seed: one "Default" profile)?
   Leaning replace: two shapes for the same concept is the smell the clean
   break just removed.
2. Should profiles sync? Endpoints are shareable, keys are not. Either split
   the record (workspace endpoint list + device-bound key map by profile id)
   or keep the whole profile device-bound. Leaning device-bound first; split
   later only if users ask for sync.
3. Transcription support: OpenAI-compatible `/audio/transcriptions` servers
   (Speaches is one) could target profiles too. Out of scope for v1.
4. Step UX: does the model field prefill from `defaultModel` and stay
   per-step, or does the profile own the model outright?

## Success Criteria (v1)

- [ ] Two profiles pointing at different local servers can be used by two steps
      of the same transformation.
- [ ] Deleting a profile that steps reference produces a clear step error, not
      a silent fallback.
- [ ] No second "single custom slot" shape survives.

## References

- `specs/20260612T090000-whispering-providers-clean-break.md` - the namespace
  this builds on
- `apps/whispering/src/lib/operations/transform.ts` - COMPLETION_PROVIDERS map
- `apps/whispering/src/lib/components/settings/ProviderConfigFields.svelte` -
  where profile management UI would live
