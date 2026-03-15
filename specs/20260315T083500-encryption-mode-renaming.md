# Encryption Mode Renaming

**Date**: 2026-03-15
**Status**: Draft

## Overview

Rename the `EncryptionMode` union from `'plaintext' | 'unlocked' | 'locked'` to `'unprotected' | 'active' | 'suspended'` for clarity. The current names use a vault metaphor that confuses developers who don't know the Bitwarden/1Password model.

## Motivation

### Current State

```typescript
// packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts
export type EncryptionMode = 'plaintext' | 'locked' | 'unlocked';
```

### Problems

1. **`'unlocked'` sounds like encryption is off.** It actually means "encryption is active, key in memory, reads decrypt, writes encrypt." A developer seeing `mode === 'unlocked'` for the first time would reasonably think the data is NOT encrypted.

2. **`'locked'` doesn't describe what's locked.** Is the data locked? The workspace? The user? It means "key was cleared, cache stays, writes throw"—a suspension of the encryption capability, not a lock on anything visible.

3. **`'plaintext'` is the least confusing** but still has an issue: it's the name for both "never had a key" AND the format of data written in that mode. Overloaded meaning.

4. **The vault metaphor requires context.** Bitwarden/1Password users understand "locked vault = need to re-enter master password." But this isn't a vault app—it's a workspace platform. The metaphor adds a layer of indirection for developers who need to understand the encryption states.

### Desired State

```typescript
export type EncryptionMode = 'unprotected' | 'active' | 'suspended';
```

| New Name | Meaning | Old Name |
|---|---|---|
| `'unprotected'` | No encryption configured. Data stored as raw JSON. | `'plaintext'` |
| `'active'` | Key in memory. Writes encrypt, reads decrypt. | `'unlocked'` |
| `'suspended'` | Key cleared. Cache readable, writes throw. | `'locked'` |

Reading `mode === 'active'` immediately communicates "encryption is active." `mode === 'suspended'` communicates "encryption is paused/frozen." `mode === 'unprotected'` communicates "no encryption at all."

## Research Findings

### Is the Bitwarden naming a formal standard?

No. Bitwarden uses "Lock" and "Log out" in their UI. 1Password uses "Lock" and "Sign Out." KeePass uses "Lock workspace." These are UX conventions in vault apps, not formal specifications. The underlying concepts (key in memory vs key zeroed) are standard in cryptographic key management (NIST SP 800-57), but the specific words "locked"/"unlocked" are informal.

### What do other encrypted storage libraries use?

| Library | States | Naming |
|---|---|---|
| Bitwarden | 2 states | Locked / Unlocked |
| Signal Protocol | N/A | Key present or not (no named states) |
| libsodium | N/A | No state machine (caller manages key) |
| Web Crypto API | N/A | Key as CryptoKey object (no modes) |

Most encryption libraries don't have named modes—the caller either has the key or doesn't. Named modes are a convenience abstraction for the workspace layer. Since there's no industry standard, we should optimize for developer clarity.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| `'plaintext'` → | `'unprotected'` | Describes the security posture, not the data format. "Unprotected" is unambiguous—no encryption. |
| `'unlocked'` → | `'active'` | Reads naturally: "encryption is active." No vault metaphor needed. |
| `'locked'` → | `'suspended'` | Key gone, capability frozen but not destroyed. "Suspended" communicates temporary pause. |
| Scope | All occurrences in workspace package + consumers | Mechanical rename via ast-grep + manual JSDoc/comment updates |

## Implementation Plan

### Phase 1: Rename the type and constants (mechanical)

- [ ] **1.1** `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` — update `EncryptionMode` type definition and all string literals
- [ ] **1.2** `packages/workspace/src/workspace/types.ts` — update JSDoc references
- [ ] **1.3** `packages/workspace/src/workspace/create-workspace.ts` — update implementation references
- [ ] **1.4** `packages/workspace/src/workspace/index.ts` — re-export (no change needed if type re-exported)

### Phase 2: Update tests

- [ ] **2.1** `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts` — ~40 occurrences of mode string literals and `satisfies EncryptionMode`
- [ ] **2.2** `packages/workspace/src/workspace/create-workspace.test.ts` — ~10 occurrences

### Phase 3: Update consumers

- [ ] **3.1** `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts` — `mode === 'unlocked'` → `mode === 'active'`
- [ ] **3.2** Any other apps referencing `workspaceClient.mode` (search all apps/)
- [ ] **3.3** Error messages containing "locked" (e.g., "Workspace is locked — sign in to write")

### Phase 4: Update documentation

- [ ] **4.1** JSDoc on `lock()`, `unlock()` in `types.ts` — references to mode names
- [ ] **4.2** Spec file `specs/20260314T234500-encryption-hygiene.md` — mode references
- [ ] **4.3** Any CLAUDE.md or AGENTS.md references

### ast-grep Strategy

Mechanical renames that ast-grep can handle:
- String literal: `'plaintext'` → `'unprotected'` (in encryption mode contexts only)
- String literal: `'unlocked'` → `'active'` (in encryption mode contexts only)
- String literal: `'locked'` → `'suspended'` (in encryption mode contexts only)

**Caution**: `'plaintext'` appears in non-mode contexts (crypto function parameters, test descriptions, JSDoc). ast-grep patterns must be scoped carefully—target `satisfies EncryptionMode`, `mode ===`, and the type definition. Manual pass for JSDoc and comments.

## Edge Cases

### Third-party code referencing modes

Consumers outside the monorepo (if any) would break. Currently all consumers are internal. The `EncryptionMode` type export ensures TypeScript catches any missed renames at compile time.

### Error messages containing old names

`"Workspace is locked — sign in to write"` needs to become `"Workspace is suspended — sign in to write"` (or a clearer message). Review all `throw` statements in the encrypted KV.

## Open Questions

1. **Should `lock()` and `unlock()` methods also be renamed?**
   - `lock()` → `suspend()`? `unlock()` → `activate()`?
   - The methods do more than just change the mode—`unlock(key)` takes a key parameter, `lock()` zeroes it
   - **Recommendation**: Keep `lock()`/`unlock()` as method names. They describe the ACTION (lock the vault, unlock with a key). The mode names describe the RESULTING STATE. Different concerns.

2. **Should the error message say "suspended" or something more user-friendly?**
   - "Workspace is suspended" might confuse end users
   - **Recommendation**: Error messages should be user-facing: "Sign in to edit" rather than exposing internal mode names

3. **Is `'unprotected'` too alarming?**
   - Alternatives: `'open'`, `'none'`, `'passthrough'`
   - `'unprotected'` clearly communicates the security posture
   - **Recommendation**: Keep `'unprotected'`. It's accurate. If you want no encryption, you should know that's what you're getting.

## Success Criteria

- [ ] `EncryptionMode` type is `'unprotected' | 'active' | 'suspended'`
- [ ] All tests pass with new mode names
- [ ] No string literal `'plaintext'`, `'unlocked'`, or `'locked'` used as mode values anywhere
- [ ] JSDoc and error messages updated
- [ ] TypeScript compilation succeeds across all packages and apps

## References

- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts` — Type definition and implementation (~60 mode references)
- `packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.test.ts` — ~40 test references
- `packages/workspace/src/workspace/types.ts` — WorkspaceClient type JSDoc
- `packages/workspace/src/workspace/create-workspace.ts` — Implementation
- `packages/workspace/src/workspace/create-workspace.test.ts` — ~10 test references
- `apps/tab-manager/src/lib/state/encryption-wiring.svelte.ts` — Consumer
