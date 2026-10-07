# Zhongwen Sync implementation

This conversation owns Git transport, Sync orchestration, installed native Folder registration, and end-to-end acceptance. The UI rethink conversation owns navigation and practice design. Keep production UI edits to a separate Sync route and one navigation link.

## Destination

- Private GitHub data: `braden-w/zhongwen-data`, repository ID `1406974656`, canonical HTTPS origin, branch `main`.
- Persistent desktop checkout: `/Users/braden/Epicenter/local/com.bradenwong.zhongwen`.
- Browser: actual Zhongwen SPA served by a loopback Bun launcher with an authenticated same-origin Git relay. GH CLI credentials stay in the relay process. The public static website remains local-only until a hosted authenticated transport exists.
- Desktop: the same release installed in Epicenter, opening the native folder registered for `com.bradenwong.zhongwen`. Git CLI uses a repository-local GH credential helper.

## Contract

Local saves work offline. Automatic commits stay local. Sync checkpoints saved files, fetches fresh state, fast-forwards or merges clean changes, then pushes. A conflict leaves files unchanged and displays both versions. Combining unrelated roots needs explicit consent and preserves both parents. No force pushes. Empty browser storage downloads the remote before editing. Drafts are not transferred as saved data.

## Verified outcome

The actual app completed the browser-to-desktop round trip through the private
GitHub remote. Browser acceptance used Chromium through Playwright; desktop
acceptance used the native accessibility UI through Computer Use.

1. A connected browser saved an expression and note offline. OPFS bytes matched.
2. Closing and reopening its profile retained the note. App Sync pushed it.
3. A fresh second profile downloaded it before editing.
4. The installed desktop app opened that same entry from the configured directory.
5. A desktop note save made local commit `ce75ae4`; native Sync pushed it.
6. The browser pulled that desktop note through its app Sync.
7. A real local Ollama tutor opening was saved in `conversations/ugrtrhorsw.md`,
   pushed by the browser, pulled by desktop, and visibly read there.
8. Two browser profiles independently added entries; clean merging preserved both.
9. Competing notes refused Sync without changing local bytes, showed both exact
   committed versions, and completed only after an explicit version choice.
10. The persistent demo host restarted, opened Zhongwen, and downloaded the final
    merged history at `1bddce6` with zero commits outstanding in either direction.

`journey.json`, `roundtrip.json`, and `concurrency.json` record the browser
acceptance. Screenshots capture offline saving, download, tutor, and conflict.
Each browser run recorded zero page errors. Native observations are in this
conversation's Computer Use results. The configured desktop checkout is clean.

## Running it again

Browser: from `/Users/braden/Code/zhongwen`, run `bun run demo:sync`, then open the
private launch link it prints. The process uses existing GH CLI authorization and
keeps the GitHub token in memory. A live acceptance launcher remains at port 5297;
normal launches default to 5207. Browser folders belong to their port/origin.

Desktop: open `/Users/braden/Applications/Epicenter Sync.app`, choose Zhongwen,
and press Sync now. This is a local debug demo host built from this checkout,
with the production capability port 39130 selected in its bundle environment.
It depends on this checkout and Bun; it is not a distributable production build.
It uses normal Epicenter app data and the registered folder
`/Users/braden/Epicenter/local/com.bradenwong.zhongwen`. The release is installed at
`~/Library/Application Support/so.epicenter/apps/com.bradenwong.zhongwen`.

## Implementation and checks

The browser Folder accepts a Git-only `gitFetch`; the remote remains canonical.
The same-origin launcher authenticates only the fixed private repository. Native
installed membership is captured in ready protocol 9, checked against the active
host generation before opening a folder, and registered for its exact window.
Folder protocol remains 8: new merge options are optional and default to false.
Native and browser merges both support explicit unrelated-root consent and exact
conflict versions. Native snapshots do not broadcast those versions to windows.

- App: 172 unit tests and 54 mounted UI checks passed; typecheck has zero errors
  and warnings. Root-site bundle checks and desktop release build passed.
- Native owner: 130 tests passed. Plugin: 20 passed, one ignored. Generated
  TypeScript bindings match the registered commands.
- Native application: 206 passed, two ignored. Its fresh debug build passed.
- Folder Tauri adapter: 48 passed. Folder typecheck has zero errors and warnings.
- Host/sidecar/build regression: 90 passed, 577 assertions.
- Browser Git transport: actual Git smart HTTP push/download and cancellation
  passed. Unrelated merge, conflict refusal, and existing merge suite passed.

The implementation is now committed in both checkouts. The domain migration
receipt records the source commits. Unrelated staged work was preserved.
Integration ledgers identify the exact worker paths copied into the live source.

## Remaining scope

The public static website has no hosted authenticated GitHub transport. It remains
local-only. Voice recording/transcription, production packaging, domain migration,
and full-quit recovery of unsent desktop drafts are separate work. Saved files and
completed tutor replies are covered by this journey. UI redesign remains owned
by the other conversation; edits here add Sync and protect existing unsaved input.
