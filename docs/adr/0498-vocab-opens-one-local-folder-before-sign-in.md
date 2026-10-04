# 0498. Vocab opens one local folder before sign-in

- **Status:** Accepted
- **Date:** 2026-10-03
- **Supersedes:** [ADR-0445](0445-vocab-saves-local-chats-and-syncs-saved-entries.md)
- **Unbuilt:** Native Vocab distribution, physical local directory placement, and configured remote synchronization. Real legacy-account import has not been exercised in the browser.

## Context

The user explicitly requested local vocabulary practice without login and a
migration to `@epicenter/folder/browser`. Keeping words in Personal while chats
live in an account-scoped device store makes identity a prerequisite for an
English learning workflow that can run entirely on this device.

## Decision

Vocab opens one account-independent folder for expressions, learner notes and
stages, chat focus, and finished messages. The mounted page opens the folder
before sign-in. The browser adapter stores one portable file per literal path in the release
Local OPFS directory for `so.epicenter.vocab`. Its first open copies any earlier
IndexedDB folder at that address, including its local history.

Each saved file's receipt is the publication boundary. The tutor receives
saved history; partial responses remain transient, and retrying a failed save
does not regenerate an answer. One selected chat owns the active tutor loop.

Connected inference endpoints and model selection belong to this device.
Optional sign-in adds hosted inference and transcription to the same folder.
It does not select another set of words or chats. Synchronization requires a
separately configured remote and is outside this migration.

Earlier account stores remain intact. An explicit import copies the signed-in
account's rows held by this browser, preserving IDs and references. Conflicts
refuse the affected rows and dependents; import never overwrites unrelated
folder files or deletes earlier data.

## Consequences

Words, notes, stages, and chats work signed out. A local OpenAI-compatible model
can run the tutor without an Epicenter account. Browser storage remains subject
to browser retention rules. Native directory access and cross-device transfer
need their own implementations and acceptance evidence.

## Considered alternatives

Keeping Personal entries behind login preserves the earlier account sync
promise but contradicts the explicitly requested local workflow. Maintaining
both Local and Personal word stores would add promotion and merge rules to
every learning action. One folder gives those actions one storage owner.
