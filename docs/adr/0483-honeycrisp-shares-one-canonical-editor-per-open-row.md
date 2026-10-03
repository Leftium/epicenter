# 0483. Honeycrisp shares one canonical editor per open row

- **Status:** Proposed
- **Date:** 2026-10-01
- **Unbuilt:** production table editor integration and removal of Honeycrisp's duplicate file-session editor engine.

## Context

Honeycrisp's `file-session.svelte.ts` owns buffers, saved captures, uncertain
attempts and observations. Other apps implement the same lifetime separately.
The canonical editor experiment places those facts behind a framework-neutral
table editor while leaving selection, autosave and close policy with the app.

## Decision

**Honeycrisp retains one folder-owned table editor for each open structured row.**
The production entry is `folder.tables.<name>.edit(stem, { signal })`. Rich
editing, body editing and metadata controls share its document. The editor owns
local changes, save attempts, observations, subscriptions and disposal. The app
owns retention, selection, autosave timing and native close fencing.

**A structured save publishes the complete canonical document through `overwrite`.**
Declared fields use declaration order; unknown keys remain and use deterministic
order. Values use canonical JSON flow spelling. YAML comments, quoting and prior
key order are not preserved. Opening or listing writes nothing. Local invalid
fields remain visible, and saving refuses until the document validates.

A schema-invalid or unsupported file remains listed and opens for separate raw
source repair. Arbitrary text files use raw file access, not an invented table
schema. The rich-body serializer must represent every admitted transaction;
canonical frontmatter does not relax body validation or erase unsupported text.

**Unknown publication remains historical evidence distinct from observation.**
A successful reply acknowledges submitted text and its capture. Typing during
that save remains dirty. An unconfirmed reply stays unconfirmed in save history;
a later matching read cannot identify its publisher. The editor can adopt clean
observations or explicitly reviewed content under its own rules without turning
that read into a successful reply. No observation cancels an outstanding command.

**The app owns autosave and close policy.**
Autosave subscribes to the retained editor and pauses after failed or unknown
outcomes. Views do not start competing timers. A native close fences input before
settling admitted work and presenting remaining drafts or unknown changes.
Only the page's response to the shell request approves closing. Explicit discard
can release a draft while preserving the unknown operation in history.

Rename and delete remain captured file operations. An unknown path change needs
inspection before renewed destructive work; it does not require a permanent
editor lock or a generic durable file-operation journal.

## Consequences

Apps share one editor engine. Honeycrisp can delete its duplicated save and
observation machinery. Frontmatter formatting changes on an explicit structured
save, so the app must disclose that behavior. Raw repair preserves access to
files the structured editor cannot open.

## Considered alternatives

- Preserve an app-owned editor engine: duplicates publication and lifetime rules.
- Preserve arbitrary YAML formatting in structured saves: requires source-patch
  machinery alongside the canonical document model.
- Convert a matching read into confirmed publication: claims a command outcome
  that an observation cannot establish.
