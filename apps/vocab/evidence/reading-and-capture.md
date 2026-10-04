# Reading and phrase capture verification (historical milestone)

Current local-folder browser acceptance is recorded in
[local-folder-journey.md](local-folder-journey.md). The observations below belong
to earlier implementations.

**Scope correction, 2026-10-03.** Vocab is for English vocabulary practice,
including SAT words, with all instructions in English. The pinyin features this
record describes have been removed: the header switch, the stored reading
preference, the reading components, the annotation code, the copy handling, and
the `pinyin-pro` dependency. Phrase capture remains as exact-text selection from
a saved tutor answer, in a module renamed `phrase-capture`. It accepts whatever
characters the answer has and does not judge language or script.

Everything below this section records the earlier milestone as it was tested.
The pinyin observations and the screenshot no longer describe the product. The
phrase-capture and publication observations were made on code that has since
changed in the ways listed above, and the changed code has not been checked in a
browser. After removal, the shared checkout passed 133 focused tests with 539
assertions across 18 files. Vocab typecheck reported zero errors and warnings;
production build, UI boundary check, and diff check passed. Capture regressions
cover English phrases across Markdown, single-line and saved-source boundaries,
exact Unicode, duplicate saves, storage refusal, retry, and preserved notes and
stages. Browser automation timed out on three recovery attempts before the
corrected interface could be observed. Post-removal visual, pointer, keyboard,
and native-copy acceptance remains pending. These results do not replace live
provider, touch, or second-device acceptance.

### Real-app startup follow-up, 2026-10-03

`bun dev:vocab` started Vocab at `http://localhost:8888/`, which returned HTTP
200. The API dashboard built, but API startup exited because Infisical was not
logged in. Browser tab inventory and creation also timed out before any current
Vocab UI could be observed. The task-owned development processes were stopped.
This establishes frontend startup only. Real sign-in, tutor responses, phrase
capture, reload persistence, and account synchronization remain unverified.

The next attempt exercised the actual app at source baseline
`3fe5cc56b560c848c4ff445e68c37d5413fed877`. Chrome control still timed out, but
the Codex in-app browser opened the current Vocab sign-in screen. Pressing
Sign in attempted the local API at port 8787 and reached a connection-refused
error because the API was not running. Infisical's session check still failed.
No account, vocabulary entry, or tutor response was simulated or created.
The frontend remains running at port 8888 with a fresh tab retained for resume.
Sign-in screenshot: `/private/tmp/vocab-real-sign-in-20261003.jpg`.

After the user authenticated Infisical, `bun dev:api` reached Ready on port
8787. In the real Vocab tab, Sign in opened Epicenter's provider choices, and
Continue with Google reached the user's Google passkey challenge. User
authentication is pending there; no words or tutor responses have been created.
Both local development servers remain running for resume. Screenshot:
`/private/tmp/vocab-google-passkey-20261003.jpg`.

Read-only Opus 5.5 consultation confirmed that `AppBoot`, `openLocal`, local
connection catalogs, and inference selections already support no account.
Vocab's route adds the mandatory sign-in gate. Personal remains an account
replica, so local-first use needs device entries plus an explicit transfer to
Personal, rather than attaching sync to the existing device document. This is
a proposed design, with no local-first implementation or acceptance yet.

## Historical record

On 2026-10-03 the actual Vocab components were exercised in Chrome over
synthetic memory stores and a scripted tutor. The fixture mounted `VocabShell`
and its production descendants. It used no live account or inference service.
Its source remains in the task artifact at
`/private/tmp/epicenter-vocab-publication-20261002/apps/vocab/.task-harness/`.
The temporary copy in the shared checkout was removed and its server stopped.

![Historical milestone: contextual pinyin, since removed, and a confirmed phrase save](reading-and-capture.jpg)

Observed behavior at that milestone:

- Pinyin appears across words, notes, chat titles, focus, and completed messages.
  Banks and music receive contextual readings across Markdown formatting.
- The preference survives closing and reopening the fixture's stores.
- Pointer selection offers base Chinese text. Copying that selection yields
  `行`, with no reading appended.
- The per-message capture button focuses an exact-phrase field. Enter saves
  `取钱`; an already stored phrase shows duplicate feedback.
- Refused Personal storage shows failure and permits saving again. The same
  phrase is stored once when storage recovers.
- Refused Local storage keeps the learner's draft, makes zero tutor requests,
  disables capture, and guards switching chats.
- Stop restores retry controls. A truncated scripted answer shows an output
  limit error and is not published as a finished answer.
- At 320 and 375 pixels, the header controls remain reachable and document
  width equals viewport width. The controls wrap at narrow widths.

Verification in the shared checkout passed 138 focused tests with 616 assertions
across the agent, client, Vocab, Home host, and AI tests. Vocab typecheck reported
zero errors and warnings; production build, UI boundary check, and diff check
passed. The reliability-only first-wave snapshot independently passed 122 tests
and Vocab typecheck. The supervisor independently passed the 16 reading and
entry tests with 158 assertions.

These checks do not establish real-provider behavior, touch selection, or
second-device synchronization. A phrase's saved state confirms this device's
Personal storage; it does not confirm account synchronization. English tutoring
remains unchanged. The user clarified on 2026-10-03 that Vocab is for English
vocabulary practice, including SAT words, with all instructions in English.
The Chinese-specific pinyin UI in this evidence was outside that intended
workflow and has been removed, as the scope correction at the top states. This
screenshot records the tested milestone, not the final product scope.

Local Mail's saved-query synchronization also remains unverified across real
devices. The pending user action is to make a second device signed into the same
Epicenter account accessible, or perform the remote step: save a named query,
report its name and SQL, and confirm a subsequent edit from this Mac there.
Mailbox synchronization and SQL execution are not needed for that check.
