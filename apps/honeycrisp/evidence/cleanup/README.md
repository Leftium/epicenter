# Honeycrisp cleanup evidence

The implementation was committed as `0ae41773836a3514f78242ba500a9ddf1f84e82e`. Claude Opus 5.5 reviewed that snapshot in an isolated clone. Codex integrated and verified the cleanup. Cleanup changes remain uncommitted.

[Opus review](opus-review.md) starts with the ASCII inventory of files read, includes the current and proposed organization, and records findings before edits and the second read of every changed file. The mechanical cleanup removes dead callbacks, unused types and exports, test-only counters, and the unused hosted build branch. Existing lifecycle, parsing, draft and transport boundaries stay in place. No files were reorganized and no dependencies changed.

[Raw-file diagnosis](raw-file-review.md) records a first-open loading failure observed in the native release app. It reproduces at the committed baseline. [Selection comparison](selection-review.md) records the subsequent strengthened test and rejected direct-getter alternative. Reading both reactive collections before branching keeps the dependency set stable during component teardown. The first regression was too weak: the strengthened test also derives the selection the way the real view does.

Final checks on the shared working checkout:

- 154 tests passed, 421 assertions, 8 files: [tests](tests.log).
- Browser and Tauri type checks: zero errors and warnings; scripts TypeScript passed: [type checks](typecheck.log).
- [Browser build](browser-build.log), [native UI, host and Tauri release bundle](native-build.log), and [Biome](lint.log) passed.
- Native release app, rooted at `/private/tmp/honeycrisp-cleanup-native-root`: opened a note, selected Files, clicked `kv.json` once, and observed its contents without reselecting. [Screenshot](raw-file-first-open.png).
- Returned to the note and opened history successfully: [screenshot](history-final.png). Quit with Command-Q; process exited successfully and the fixture repository remained clean.

The first `history.png` and `raw-file-after-reselect.png` capture the pre-repair smoke test. `desktop-ui-build.log` is the isolated mechanical cleanup build before the selection repair. Other final logs replace the earlier smoke-test logs. Baseline and direct-getter failure logs accompany the successful real-component log.

The shared checkout also contains another chat's automatic-history policy changes. Those changes account for three additional tests compared with Opus's isolated 151-test run. They were preserved and are outside this cleanup's ownership. No other chat's work was staged or committed here.

The retained selection repair copies two small maps on recomputation. The direct getter still failed with the real view's derived selection; changing every consumer to avoid deriving it would leave a silent correctness constraint on future callers.
