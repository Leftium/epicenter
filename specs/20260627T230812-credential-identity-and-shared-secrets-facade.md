# Credential identity and the shared secrets facade

**Date**: 2026-06-27
**Status**: Draft
**Owner**: platform / inference + secrets
**Relates**: [ADR-0074](../docs/adr/0074-the-secret-vault-is-an-owner-scoped-synced-store-encrypted-under-a-server-derived-keyring.md) (the vault this facade fronts), [ADR-0078](../docs/adr/0078-whispering-authenticates-with-an-oauth-bearer-on-every-surface.md) (the auth wave that delivers the keyring)

## One Sentence

A brought credential gets a durable logical identity independent of its endpoint, so one `available | missing` secrets facade is the single home for provider keys across apps and a chat connection stops carrying its own `apiKey`.

## How to read this spec

```txt
Read first:    One Sentence, Motivation, The core question, Open Questions
Read for design: Research Findings, Architecture, Implementation Plan
The decision that gates everything: "Refuse custom cloud BYO in chat?" (Open Question 1)
```

## Overview

A greenfield grill (three read-only agents plus a Codex adversarial pass) set out to unify the secret-credential layer across apps. The agents proposed "extract Whispering's facade and split the `apiKey` out of chat connections." Codex found the blind spot all three missed: the real problem is not *where* an `apiKey` string is stored, it is **what durably identifies a brought credential**. Splitting the key out without fixing identity just moves the ambiguity. This spec fixes identity first; the facade and the connection-key split follow from it.

## Motivation

### Current State: one concept, two incompatible shapes

A "brought" provider key exists in two unrelated shapes today.

**1. Whispering: named keys behind a facade.**

```ts
// apps/whispering/src/lib/state/secrets.svelte.ts
secrets.get('providers.openai.apiKey'); // -> { status: 'available'; value } | { status: 'missing' }
```

The identity is a stable logical name (`providers.<id>.apiKey`). There is a real `available | missing` contract.

**2. Chat apps (tab-manager, opensidian, vocab): the key buried in an arbitrary connection.**

```ts
// packages/app-shell/src/inference-picker/connections.svelte.ts:52
// connectionSchema: { baseUrl: string, apiKey?: string }
// packages/client/src/connection.ts:110,135 attaches `Authorization: Bearer` straight off the object
```

The identity is the connection's **mutable `baseUrl`**. There is no facade and no `missing` contract.

### Problems

1. **No durable identity.** A connection is keyed by `baseUrl`. Rename the endpoint and the key orphans. Two endpoints that share a `baseUrl` but need different keys cannot coexist. "Discovered but not yet saved" has no slot.
2. **No contract.** Chat keys have no `available | missing`; a blank key can reach a provider SDK (the exact failure the Whispering facade was built to prevent).
3. **Two homes that cannot merge.** Whispering's named-key facade and the chat connection-key cannot share one vault because they do not agree on what identifies a key. A vault keyed `providers.groq.apiKey` cannot model an arbitrary custom endpoint; a vault keyed by `baseUrl` is fragile. ADR-0074 invariant 3 (one user-global vault) is unreachable until identity is settled.

### Desired State

A brought credential has a stable logical identity. The vault is keyed by that identity. A connection becomes a non-secret pointer that references a credential, never an inline secret.

## Research Findings

Per-app brought-credential storage (from the hunt's catalog):

| App | Brought credential | Identity today | Facade / contract |
| --- | --- | --- | --- |
| whispering | 9 named provider keys | `providers.<id>.apiKey` (stable) | yes (`available\|missing`) |
| tab-manager | custom inference connections | `baseUrl` (mutable) | no |
| opensidian | custom inference connections | `baseUrl` (mutable) | no |
| vocab | custom connections; `whisper-1` dictation key resolves through the same list | `baseUrl` (mutable) | no |
| matter | none | n/a | n/a |
| local-books | QuickBooks OAuth tokens | per `realmId`, file-backed `0600` (off-relay) | stays out of scope (ADR-0004/0062) |

**Key finding:** only Whispering models a credential by a stable identity. The chat apps model it by a mutable endpoint. Unifying storage without unifying identity is a false start.

## The core question: what identifies a brought credential?

| Model | Identity | Models custom endpoints? | Cost |
| --- | --- | --- | --- |
| **A. Named provider only** | `providers.<id>.apiKey` | No | Refuses arbitrary OpenAI-compatible BYO endpoints |
| **B. Connection-keyed (status quo)** | `baseUrl` (mutable) | Yes, fragilely | Orphans on rename, no contract, no merge |
| **C. Explicit credential id** | a generated `CredentialId`; connections reference it; named providers get well-known ids | Yes, durably | A new id concept + a join the UI must manage |

**The radical option (Codex):** refuse arbitrary custom cloud BYO in chat *for now*. Chat gets the hosted gateway plus keyless local endpoints; a named provider key lands in the vault only when a named-provider flow earns it. Delete `apiKey` from the chat `Connection` entirely.

This collapses the identity problem instead of solving it: if only named providers carry keys, every key already has a stable identity (model A), and the connection is purely `{ baseUrl }` (a non-secret device pointer that could even sync safely). Model C is the escape hatch added later *if* a real "custom cloud endpoint with its own key" need appears; it is not built speculatively.

## Architecture

```txt
named provider key  ->  secrets facade (one home, available|missing)  ->  vault (synced, when authed) | device (degenerate)
custom endpoint     ->  connection { baseUrl }  (non-secret pointer; no inline key)
resolveConnection   ->  reads the key from the facade by the connection's provider identity, not off the connection object
```

- **Facade home:** `@epicenter/app-shell/secrets` (a new export beside `inference-picker`), NOT a standalone `@epicenter/secrets` package. app-shell already hosts cross-app device-local state and depends on the right packages; a standalone package would be over-extraction with no non-Svelte consumer (local-books deliberately stays file-backed).
- **Facade API:** `get(key): SecretRead`, `set`, `forget` (local replica wipe, never a propagated delete), and the auth seam `activate(vaultDoc, keyring)` (dark until the auth wave delivers a keyring). One home per secret (ADR-0074 invariant 4): the facade never reads two places and merges.

## Implementation Plan

Sequenced after Open Question 1 is answered. Earned-now vs needs-the-keyring is the dividing line.

### Wave 1: the facade, device-local (earned now, no auth)
- [ ] **1.1** Extract `@epicenter/app-shell/secrets` (`createSecrets({ device, homeOf? })`), device-backed, `available | missing`. Keep `activate()` as a dark seam.
- [ ] **1.2** Point Whispering's `secrets.svelte.ts` at it (read contract unchanged).

### Wave 2: credential identity + the connection-key split (the decision lands here)
- [ ] **2.1** Apply Open Question 1. If "refuse custom cloud BYO": delete `apiKey` from `connectionSchema`; the connection persists as `{ baseUrl }`. If "keep custom BYO": introduce `CredentialId` (model C) and a connection->credential reference.
- [ ] **2.2** `resolveConnection` reads the key from the facade by provider identity, not off the connection object (`packages/client/src/connection.ts:110,135`).
- [ ] **2.3** The three chat apps gain the `available | missing` contract for free (the change lives in app-shell).

### Wave 3: the synced vault wire (deferred, needs the auth wave)
- [ ] **3.1** Attach the `epicenter:secret-vault` doc, `activateEncryption(session.keyring)`, first-sign-in device->vault migration. Blocked on ADR-0078's keyring delivery. This is the "Wire the vault to the session" wave.

## Open Questions

1. **Refuse custom cloud BYO in chat (the product call that gates this spec).**
   - Options: (a) refuse it now (chat = hosted gateway + keyless local endpoints; only named providers carry keys); (b) keep it, and introduce an explicit `CredentialId` (model C).
   - **Recommendation:** (a) for now. It collapses the identity problem to model A, deletes `apiKey` from the connection, and defers the `CredentialId` machinery until a real custom-cloud-BYO need exists. Reversible: model C slots in later without re-storing anything. **This is the user's decision; the rest of the spec forks on it.**

2. **Named-provider id scheme.** Reuse Whispering's `providers.<id>` enumeration, or a shared registry? Recommend a shared `providers.<id>` registry in app-shell so Whispering and chat agree on names. Defer until 2.1.

3. **Does a device-pointer `{ baseUrl }` connection sync?** With no inline key it is no longer a secret, so it *could* sync as ordinary config. Out of scope here; note it for the vault wave.

## Success Criteria

- [ ] One `available | missing` facade is the sole home for brought provider keys; no consumer reads a raw key off a connection object.
- [ ] A chat connection carries no inline secret.
- [ ] Whispering's read contract is unchanged.
- [ ] Identity survives an endpoint rename (no orphaned keys).
- [ ] matter and local-books untouched.

## References

- `packages/app-shell/src/inference-picker/connections.svelte.ts:52` - the `{ baseUrl, apiKey? }` schema to split.
- `packages/client/src/connection.ts:110,135` - where the bearer is attached off the connection object.
- `apps/whispering/src/lib/state/secrets.svelte.ts` - the named-key facade to generalize.
- `docs/adr/0074-...md` (the vault), `docs/adr/0078-...md` (the keyring-delivering auth wave).
