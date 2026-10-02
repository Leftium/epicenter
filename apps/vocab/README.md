# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Words is the starting view. Each saved expression has an exact text, a learner-owned note, and one self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

## Learner flow

Add an expression directly, paste one expression per line, or browse the small built-in starter list. Paste and starter lists use the same review: blanks, repeated exact text, and already-saved text are skipped; eligible expressions are selected by default. Confirmed additions have empty notes and the New stage. Words provides search, stage filtering, note editing, and stage controls.

Choose one to three saved expressions in Words and start a chat. Vocab saves the chosen focus on this device before requesting a tutor opening. The tutor speaks first, and the learner can follow up. A stopped or failed opening leaves the chat available for explicit retry.

### Saving a phrase

A phrase comes from one line of one finished tutor answer that this device has saved. Select it with the pointer, the keyboard, or touch handles, or press the answer's "Save a phrase" button and type or paste it. Either way it must be an exact run of that answer's text, trimmed and otherwise unchanged. A selection across two messages or two lines, or in an answer that is still arriving or unsaved, offers nothing. The source is checked again when the phrase is accepted.

The phrase becomes one entry with an empty note and the New stage. "Saved to your words" appears once this device's Personal storage confirms the entry, not when the row is merely accepted. A phrase storage refused stays in the list and can be saved again without a second row. An exact text that is already stored is reported as already in the list.

### Pinyin

The Pinyin switch in the header is one device-wide preference. While it is on, Han text is drawn with pinyin above it wherever vocabulary or conversation text is read: words, import review, notes, focus words, chat titles, finished messages, and the phrase preview. A character is read as part of its line, so 银行 is yín háng even when Markdown emphasis splits it. Input fields and a reply that is still arriving show plain text.

Readings are display only. They are derived from the text on screen and are never stored in an entry, a note, or a transcript, and never sent to a tutor. Selecting or copying text leaves them out. English text has no readings and is unchanged, as are the starter list and the tutor's prompt.

### Chat history

Chat history stays on this device. Desktop Chat shows history, conversation, and focus words side by side; narrow Chat offers history and focus controls above the conversation. Returning to Words keeps the selected chat's draft and stream, but closes dictation and discards speech not yet inserted. Switching chats disposes the previous loop and its unsent draft. Focus text stays visible if its saved entry is deleted; its stage control then disappears. Earlier message-only chats remain readable, with their first learner question as the title.

## Data ownership

```text
openLocal(chatHistoryDefinition)              This device
  kv.showPinyin                            The reading preference; unset reads as off
  chats                                    Account key, creation time, fixed focus snapshot
  messages                                 Account key, conversation ID, finished message

openPersonal(vocabDefinition, { account })    Personal account
  entries                                  Exact text, note, stage, creation time
```

The chat row ID is the conversation ID on its messages. A focus item holds the original text and its Personal entry ID. Notes and stages remain in Personal entries and follow the account across devices. Local rows carry an account key so switching accounts shows only that account's device history. Legacy message-only chats are read without fabricating a focus row; this compatibility reader can retire only after those histories have an explicit preservation path.

The app runs the UI-free `@epicenter/agent` loop over Local message rows. An unsent draft and partial response are not durable. The selected chat owns the only live loop.

A table write only accepts a row into the live document, so a message counts as saved once the Local store's `persistence.flush()` settles with the status `saved`. Three rules follow:

- The tutor is asked only over saved history. A learner message is saved before generation, and the opening and every retry confirm the focus and transcript first. A draft stays in the input until its message is saved.
- A tutor answer is saved only after a clean finish. A stopped, failed, filtered, or cut-off answer is not saved. A complete answer that storage refuses stays on screen and copyable; it is not a phrase source until it is saved.
- A storage failure has its own notice and its own "Save again", which writes again and never asks the tutor. Tutor failures keep their separate retry. Leaving a chat that holds an unsaved message asks first. The inference picker saves one device workflow choice for the account; an unavailable model leaves Words and history usable.

## Development

Start from the repository root with `bun dev:vocab`. Run `bun run --cwd apps/vocab typecheck` and `bun test apps/vocab/src/lib` for focused checks.
