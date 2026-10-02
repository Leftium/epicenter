# Folder workflow browser baseline

Date: 2026-10-02. Browser: Chrome, actual computer use through documented `mcp__cua_repl` actions. No page evaluation, hidden application state, or production source edits. Used disposable `sim-20261002-` files only; existing todo `95zg91do01.md` untouched. Original new todo initially had an app-generated UUID and was immediately renamed to the simulation prefix.

## Observed boundary

`http://127.0.0.1:5186/` is a browser IndexedDB working copy. Status details explicitly say: “This browser”, “Saved in this browser's storage, not in a folder on this computer.” The embedded terminal reads and writes that same browser filesystem. Native filesystem interaction is a separate disposable Git checkout, coordinated by the root agent at `/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/epicenter-todos-rPykjS/native`.

## Normal app and terminal flow

1. Type `sim-20261002-normal` in New todo title and press Enter.
2. The app opens the new todo with Title, Done, Notes/Source, File name, Rename file, and Delete controls.
3. Rename its app-generated UUID stem to `sim-20261002-normal` using File name and Rename file.
4. Type “Initial notes from the todo editor.” into Notes.
5. Open Terminal. Run `cat todos/sim-20261002-normal.md`.

Actual file: YAML fences, `title: sim-20261002-normal`, `done: false`, then Notes body. App edits autosave and commit, showing “not pushed”. Terminal writes show “uncommitted change”.

6. Run `printf '%s\n' '---' 'title: sim-20261002-normal edited in terminal' 'done: true' '---' 'Body edited in embedded terminal.' > todos/sim-20261002-normal.md`.

Actual: list title, detail Title, Done checkbox, and Notes update live. Same file identity remains selected.

## Partial invalid field and repair

1. In embedded terminal create `todos/sim-20261002-bad-field.md` with fenced frontmatter `title: sim-20261002-bad-field`, `done: soon`, and body “Usable body with invalid done.”
2. Select its Todo row.

Actual: row remains visible with Needs repair; list checkbox disabled. Detail retains usable title and notes. Diagnostic: “done does not conform: must be boolean”. Detail Title remains editable. Editing title changes only title; switching to Source proves invalid `done: soon` and body are retained.

3. In Source change done to false and title to `sim-20261002-bad-field repaired`.

Actual: diagnostic clears, list checkbox re-enables, title and body remain usable. Source editing autosaves after debounce. An immediate terminal cat can still see the previous saved version while the view says Unsaved typing; after debounce the repaired row updates.

## Missing fences, raw saving, and repair

1. In terminal create `todos/sim-20261002-malformed.md` containing `title: sim-20261002-malformed`, `done: false`, and “Body without YAML fences.” without fences.
2. Select its Todo row.

Actual: malformed file stays visible in Files and Todos, selectable, Needs repair. Title, Done, and Notes disabled; Source editable. Message: “The source does not start with a --- line opening its frontmatter. Edit the source to fix it; the text is saved as written.” The same underlying error is repeated below in the diagnostic list.

3. Type malformed source with “Raw malformed draft remains saveable.” into Source.
4. After autosave, run terminal cat.

Actual: malformed text saved verbatim. It is not dropped, hidden, coerced, or rejected.

5. Restore opening/closing `---`, valid title and done:false, retaining body.

Actual: Title/Done/Notes re-enable and Needs repair clears.

### Repair discoverability

A separate `todos/sim-20261002-repair-discovery.md` reproduced entry from Notes: leave Notes selected on a healthy todo, then select malformed Needs repair row. Notes remains selected but blank/disabled; Title blank/disabled and Done disabled. Message says to edit source, but there is no action in the repair message. The user must click Source tab to see and repair the original text. Source tab is adjacent and usable, but this extra step makes the broken item initially appear empty. This sample was repaired and retained in the original origin's local divergent commits.

## Literal whitespace identity

Create terminal file `todos/sim-20261002- spaced .md` with valid frontmatter/title/body. Actual: projected Todo row visible, file selectable, Source and title usable. File name field retains the literal trailing space, and saved path retains internal/trailing spaces. No normalization observed. Bare `todos/.md` was not tested because the simulation scope permits only sim-prefixed disposable paths; nested empty-stem projection also not tested.

## Outside edit while draft is unsaved

1. Select normal todo Source.
2. Prepare terminal printf replacement (do not execute yet) with outside title, done:false, body “Outside body preserved.”
3. Set Source draft to local title `sim-20261002-normal unsaved draft`, done:true, body “Local unsaved body preserved.”
4. Immediately execute prepared terminal command before debounce saves draft.

Actual: list reflects outside saved title, detail retains local draft title/body. After debounce: “This file changed elsewhere. Your edits are kept here and not saved.” Two buttons: “Discard mine and load saved” and “Save mine over it”. Status: “1 file not saved”. Terminal cat proves outside title/done/body remains on filesystem. Screenshot emitted with local source and terminal outside source visible together.

5. Click Discard mine and load saved.

Actual: detail now loads saved outside version; conflict message clears. Save mine over it alternative was not exercised.

## Native filesystem Git round trip and divergence

1. Original browser UI Commit and push succeeds; status Up to date; local/remote `a5c093b`.
2. Coordinator ordinary native checkout pull, edit only sim-normal Markdown to title `sim-20261002-native editor round trip`, done:true, extra `agentOnly: preserved by native writer`, body “Native filesystem edit: café 🥔.”; commit/push `36fcf93`.
3. During the crossed ready messages the browser also added/repaired repair-discovery. Local browser commits `2e6d2c8`, `600d0c2`, and `af9c2f5` diverged from native `36fcf93` at common `a5c093b`.

Actual browser push refusal:
“Committed 600d0c2 · Push failed”
“Update todos/sim-20261002-repair-discovery.md Push rejected because it was not a simple fast-forward. Use \"force: true\" to override. Local commits are kept.”

Actual UI Pull refusal:
“Pull stopped”
“Local and remote history have diverged; local commits are kept. Resolve the histories before pushing.”

Status: Push failed · 3 not pushed, 1 incoming. Local head `af9c2f5`. No reset, force push, undo, or deletion. No lost files observed. Embedded terminal supports push without arguments and pull --ff-only, with no merge/rebase recovery. This is an explicit browser demo limitation; ordinary native Git can reconcile histories when both are available, but UI alone does not offer reconciliation.

### Clean inbound and outbound proof without resetting the original origin

1. Open second Chrome tab `http://localhost:5186/`, a separate IndexedDB origin. Initially No commits yet, no files.
2. Click Pull.

Actual: “Pulled 5 files”, “none → 36fcf93”; status Up to date. Select sim-normal: title from native writer; Done checked; Notes contains “Native filesystem edit: café 🥔.” Source also includes unknown agentOnly.

3. Edit Title in UI to `sim-20261002-browser return trip`.
4. Embedded terminal cat after autosave.

Actual: title changed, `done: true` unchanged, `agentOnly: preserved by native writer` retained, Unicode body retained. This is exact observed source:

```md
---
title: sim-20261002-browser return trip
done: true
agentOnly: preserved by native writer
---
Native filesystem edit: café 🥔.
```

5. Click Commit and push.

Actual: “Nothing new to commit · Pushed aa708aa”, status Up to date. Coordinator ordinary native pull of aa708aa confirmed the actual disk title, done:true, unknown agentOnly field, and café/emoji bytes were retained. Outbound native verification passes. Screenshot emitted showing Up to date, detail Source, and terminal cat with identical contents.

## Candidate fixes grounded in the workflows

1. Render parse error once. Summary currently duplicates first diagnostic for a malformed document. Same workflow has no additional useful information in the second copy.
2. Offer an Edit source action in the repair message or select Source when an unreadable item is opened. Current selection retains blank disabled Notes and needs an extra manual Source click.
3. Replace raw library push advice with app-owned copy. “Use force:true” leaks API advice into a UI that deliberately keeps local commits and exposes no such operation. Preserve the explicit divergence explanation and recovery boundary.
4. Consider title/identity layout: list rows show title and stem side by side; the long technical stem can receive more visible width than the human title. Simulation titles truncate severely while stems stay prominent. This is visual friction, not evidence of an identity error.

## Evidence and limitations

All interactions and inspection used documented cua browser AX/click/type/setValue/pressKey/scroll/screenshot APIs. Screenshots emitted through tool output at malformed recovery, explicit draft conflict, and final native/browser round trip. The documented screenshot interface returns bytes but exposes no disk-save API; no hidden browser or OS calls were used to save them.

Both Chrome tabs marked handoff for focused rerun. Original tab ID `672030389`, 127 origin local divergent state preserved. Clean tab ID `672030390`, localhost origin at aa708aa with selected normal file. No app source edited. No user storage reset or preexisting files changed. No public deployment or external network publishing.

Untested: native folder directly mounted in browser, process restart/watchers across filesystem provider lifecycle, bare empty stem, alternate schema projection in UI, Save mine over it, manual merge recovery, malformed YAML beyond missing opening fences, and all other example apps. Root's separate experiments/review cover schema composition and architecture.
