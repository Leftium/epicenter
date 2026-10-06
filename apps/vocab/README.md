# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Words is the starting view. Each saved expression has an exact text, a learner-owned note, and one self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

All tutor instructions are in English. SAT vocabulary is one expected use case;
saved expressions and phrase capture preserve ordinary Unicode text without
restricting it to a word list or script.

Vocab opens straight to Words with no sign-in. Words, notes, stages, chats, and finished messages are saved in one folder in this browser. Nothing is synced to another device; a remote would have to be configured separately. Signing in is optional and only adds Epicenter's hosted tutor models and dictation.

## Learner flow

Add an expression directly, open Add multiple to paste one expression per line, or browse the small built-in starter list. Closing Add multiple keeps the pasted text and any open review. Paste and starter lists use the same review: blanks, repeated exact text, and already-saved text are skipped; eligible expressions are selected by default. Confirmed additions have empty notes and the New stage. Words provides search, stage filtering, note editing, and stage controls. A word appears once its file is saved; an addition the folder refused stays in the field or the review for another try.

Each word's card opens the folder's row editor for it when the card is shown, and the page keeps that editor for every view of the word; the note field is disabled until it opens. Every note keystroke and stage press is saved at once as the whole word: note, stage, and whatever else the file holds, line endings included. One write runs at a time and the latest change waits behind it. The word is read from its file once, when it opens; a change saved meanwhile in another tab or program is shown only when the learner presses "Reload file", and is otherwise replaced by their next save. A note no file can hold exactly, such as one with half of a surrogate pair, is not sent: it stays in the field with the reason until the learner corrects it, chooses "Discard this note", or deletes the word, and meanwhile the word cannot be reloaded. A save that failed or got no answer is shown, unknown when unknown, and the learner's text stays in the field. The error stays visible while a newer save runs and clears when a save or reload succeeds. The latest waiting edit proceeds after failure, and later typing or a stage change saves again. "Try again" saves the current text; "Discard mine and reload the file" reads the file and shows it instead. Leaving the page while a word is saving, its save failed, or its note was refused asks first.

A file that no longer reads as a valid word shows its exact text in the same editor, and each change to it is saved as typed. Once the text reads as a valid word again, "Show note and stage" returns to the note and stage controls. No save creates a word whose file is gone: what the learner typed stays shown until they let it go.

Delete asks first, and says that any change not saved yet is discarded. Deleting destroys the word with what it holds unsaved: a failed save or a refused note does not stop it, and nothing is saved again first. Pressing Delete fixes the word it names and the version the list showed; a list read again while the dialog is open does not change either, and the dialog still deletes that word if its card leaves the page. Confirming waits for saves already running to settle and removes the file only if it is still the listed version or the word's own saved text. Nothing is deleted once the page is closing. A delete that is refused keeps the word, its text, and any failed save or refused note exactly as they were. When a delete's answer is lost, the word stays with "Check again", which reads its file, and "Let it go". A word whose file is still there goes on as before, and one whose file is gone can be let go. One delete runs at a time per word, and leaving the page waits for one already sent.

Choose one to three saved expressions in Words and start a chat. Vocab saves the chosen focus before requesting a tutor opening. The tutor speaks first, and the learner can follow up. A stopped or failed opening leaves the chat available for explicit retry.

### Saving a phrase

A phrase comes from one line of one finished tutor answer that is saved. Select it with the pointer, the keyboard, or touch handles, or press the answer's "Save a phrase" button and type or paste it. Either way it must be an exact run of that answer's text, trimmed and otherwise unchanged. A selection across two messages or two lines, or in an answer that is still arriving or unsaved, offers nothing. The source is checked again when the phrase is accepted.

The phrase becomes one entry with an empty note and the New stage. "Saved to your words" appears once the folder holds the entry's file. A phrase the folder refused is not added and can be saved again. An exact text that is already in the list is reported as already there, and its note and stage are left alone.

### Chat history

Below 768px, Words and Chat sit in a bottom navigation bar; desktop keeps them in the header. A selected practice action sits above the bar without covering words. Chat returns to the selected conversation without opening History. Desktop Chat shows history, conversation, and focus words side by side; narrow Chat offers separate history and focus controls above the conversation. Returning to Words keeps the selected chat's draft and stream, but closes dictation and discards speech not yet inserted. Switching chats disposes the previous loop and its unsent draft. Focus text stays visible if its saved entry is deleted; its stage control then disappears. Earlier message-only chats remain readable, with their first learner question as the title.

### Choosing a model

The model picker lists the endpoints saved in this browser and lets the learner connect an OpenAI-compatible endpoint, such as a local Ollama at `http://localhost:11434/v1`. That works signed out. Connected endpoints and the chosen model are kept for this device, not for an account, so they are the same signed out and signed in: signing in adds Epicenter's hosted models beside them and takes nothing away. Signing in or out reloads the page onto the same folder: no word or chat is hidden or removed. A chosen hosted model is unavailable while signed out, and the picker asks for another. Dictation uses hosted transcription, so its button appears only when signed in.

## Data ownership

```text
openFolder({ id, definition: vocabFolder }) One folder in this browser (OPFS), ID so.epicenter.vocab
  entries/<SHA-256 of the text>.md          Exact text, note, stage, creation time
  chats/<id>.md                             Creation time, fixed focus snapshot
  messages/<message id>.md                  Chat ID, one finished message
```

`src/lib/data.ts` declares how the folder's files read and `src/lib/folder.ts` opens it as `VOCAB_FOLDER_ID` through `@epicenter/folder/browser`. The folder is one directory in this browser's origin private file system, `Epicenter/local/so.epicenter.vocab`, holding the files and their Git history. It is not a directory on disk: Vocab has no desktop build, and inside the desktop app the opener refuses instead of opening browser storage. No row has an account in it.

This version is a clean break from earlier ones. Vocab does not read, copy, or delete what an earlier version saved in IndexedDB, in an account's Personal store, or in a device chat store; it starts from the OPFS directory alone.

A new word's file is named by the SHA-256 of its exact UTF-8 text and created exclusively. Adding one text twice, from one tab or two, or again after an answer that never arrived, reaches the same file: one add creates it and the others find it, with its note and stage as they are. A different file at that name is refused and left alone. A word file under another name, such as one written outside Vocab, is found by its text in the list.

A chat's ID is the `chat` field of its messages. A focus item holds the original text and its entry's ID. Messages whose chat has no `chats` file are an earlier message-only chat and are listed without a focus.

A file Vocab cannot read as a row, because its text does not parse or a field does not conform, is listed by path with the reason and left as it is. It is never dropped from view silently.

The app runs the UI-free `@epicenter/agent` loop over one chat's message files. An unsent draft and a partial response are not saved. The selected chat owns the only live loop.

A save is confirmed by the folder's receipt for that file, and nothing is shown as saved before it. Three rules follow:

- The tutor is asked only over saved history. A learner message is a file before generation, and the opening and every retry read the chat's messages from the folder first. A draft stays in the input until its message is saved. A folder that cannot be read asks nothing and has its own "Read again".
- A tutor answer is saved only after a clean finish. A stopped, failed, filtered, or cut-off answer is not saved. A complete answer that the folder refuses stays on screen and copyable; it is not a phrase source until it is saved.
- A failed save has its own notice and its own "Save again", which writes the same file again and never asks the tutor. Tutor failures keep their separate retry. Leaving a chat that holds an unsaved message asks first. The inference picker saves one workflow choice in this browser; an unavailable model leaves Words and history usable.

A message's file is named by its ID and created exclusively, so saving it again adds no second file and a different message at that name is refused.

## Development

Start from the repository root with `bun dev:vocab`. Run `bun run --cwd apps/vocab typecheck` and `bun test apps/vocab/src/lib` for focused checks. The tests run the real modules over the real browser folder on an in-memory OPFS stand-in. `bun run --cwd apps/vocab test` also runs `test:svelte`, which mounts the real word card in jsdom under the browser build of Svelte; it shows what delivered events do, not layout, focus, or IME.
