# 0478. Folder is an independent package with automatic and explicit openers

- **Status:** Proposed
- **Date:** 2026-10-01
- **Unbuilt:** the independent Folder package, shared declaration/compiler dependency extraction, matching adapter entrypoints, consumer migration, and production verification of runtime and build specialization.

## Context

The file-authoritative Folder implementation currently lives in
`@epicenter/app/files`. It exposes tables, KV, literal files, and Git history.
Browser acquisition uses IndexedDB; the current ordinary-directory opener
runs in Bun. The shared Rust plugin migration supplies the replacement desktop
implementation.

A developer building a file-backed application should install this capability
without also installing App's authentication, recording, AI, and document-store
dependencies. The default application code should work in browsers and Tauri.
Developers targeting one environment also need explicit control over acquisition
and emitted assets without changing the Folder contract.

## Decision

**`@epicenter/folder` owns the portable Folder implementation and contract.**
Move the coherent implementation rather than adding a wrapper above App.
The package owns table/KV interpretation, Markdown patches, and the public
`tables`, `kv`, `files`, and `git` vocabulary. Its browser adapter owns browser
storage and history; its Tauri adapter uses the shared Rust implementation.
Generated native bindings remain internal to this package, not a separately
installed JavaScript SDK.

The matching Cargo crate is `tauri-plugin-epicenter-folder`, imported in Rust
as `tauri_plugin_epicenter_folder`, with Tauri identifier `epicenter-folder`.
The shell installs and registers it, configures permitted roots, and grants
window authority. A JavaScript import cannot register native code or grant
access to a directory.

**Every public acquisition entry exports `openFolder` with the same portable contract.**

```ts
// Normal application code: choose at acquisition time.
import { openFolder } from '@epicenter/folder';

// Explicit choices: use one implementation.
import { openFolder } from '@epicenter/folder/browser';
import { openFolder } from '@epicenter/folder/tauri';
```

These are the intended exports; they do not describe packages already shipped.
The root checks `isTauri()` when called and lazily loads the selected adapter.
Imports acquire no resource. Ordinary server-side acquisition refuses.
The browser entry supports explicit IndexedDB injection for tests and refuses
a detected Tauri environment; the Tauri entry asserts its environment.
All entries export shared vocabulary directly from an inert contract module,
so explicit imports cannot pull the automatic selector back into their graph.

After selecting Tauri, missing registration, denied permission, unknown scope,
or an incompatible plugin protocol fails visibly. None opens IndexedDB as a
fallback. Shell bootstrap must establish the native environment before
application startup: an entirely unmarked page cannot be distinguished from
a browser by the package. The logical folder identity defaults to the
definition's ID; native startup maps it to a permitted scope, never an
arbitrary page-supplied disk root.

**A build can specialize the root import without changing application source.**
An exact-match Vite alias can resolve it to either explicit entry:

```ts
resolve: {
  alias: [{
    find: /^@epicenter\/folder$/,
    replacement: '@epicenter/folder/browser',
  }],
}
```

Use `/tauri` for a desktop-only artifact. Match the bare root only; do not
rewrite subpaths. The default root needs no Vite configuration. One identical
artifact includes or references both lazy adapters. Specialized builds retain
the same caller source but emit separate artifacts with one adapter graph.
Signature parity allows TypeScript to check the root contract while the build
resolves a leaf. Verify all emitted chunks rather than assuming tree shaking
removed the unused implementation.

**Extracting Folder narrows App; it does not rename App or absorb its other resources.**
Field recognition, declaration types, and compilation currently serve both
file storage and App stores. Extract their minimum common behavior below both
consumers without copied validation or a circular dependency. Keep Yjs body
helpers and App-specific storage behavior outside Folder. Select the shared
package name only after checking its complete import closure.

Folder declarations can expose `defineFolder` when it validates supported
file schemas before acquisition using the existing field/table vocabulary.
It must not merely alias `defineStore` or invent another schema language.
Move consumers to the independent package and retire the replaced App file
entrypoints after their callers migrate. A remaining Bun/Node opener needs
an explicitly named runtime entry if live CLI or server consumers require it;
it must not be confused with the Tauri adapter.

## Consequences

Ordinary callers choose one import and use the same Folder methods everywhere.
Advanced callers can select an explicit entry, or specialize a build while
retaining their application imports. Build specialization changes deployment
compatibility; a wrong-target artifact fails rather than silently opening the
wrong storage. Browser and native stores remain separate data locations.

Automatic output includes unused adapter assets. Lazy loading reduces loading
work, not emitted assets. Specialization primarily targets distributed size;
measure the production graphs before adding tooling. A small Vite fixture
confirmed that the exact alias excludes the opposite adapter while retaining
the shared contract. Production adapters and real Tauri acquisition remain
unverified by that fixture.

The extraction has a dependency cost: schemas and compiler behavior must move
coherently while App's remaining APIs continue to work. Package extraction must
not block verification of the shared native implementation or create a second
plugin. A later decision about App's remaining scope requires its own caller
inventory; this record does not authorize a broad rename or resource migration.

## Considered alternatives

- Separate platform-named functions at the root expose a choice ordinary
  applications should not have to make. Subpaths retain explicit control.
- A package that re-exports App's Folder adds another boundary while retaining
  unrelated dependencies.
- Renaming all of App to Folder incorrectly includes document stores and other
  capabilities in a file-authoritative package.
- A mandatory Vite plugin, global build constant, or custom export condition
  introduces coordination that one optional alias does not need.
- Catching native acquisition failure and opening browser storage makes a
  broken desktop configuration appear to work in another data location.
