# Vocab

Vocab helps a learner collect English expressions and practice using them in tutor-led conversations. Words is the starting view. Each saved expression has an exact text, a learner-owned note, and one self-reported stage: New, Recognize, Understand, or Use. Only the learner changes the stage.

All tutor instructions are in English. SAT vocabulary is one expected use case;
saved expressions and phrase capture preserve ordinary Unicode text without
restricting it to a word list or script.

Vocab opens straight to Words with no sign-in. Words, notes, stages, chats, and finished messages are saved in one folder in this browser. Nothing is synced to another device; a remote would have to be configured separately. Signing in is optional and only adds Epicenter's hosted tutor models and dictation.

## Learner flow

Add an expression directly, paste one expression per line, or browse the small built-in starter list. Paste and starter lists use the same review: blanks, repeated exact text, and already-saved text are skipped; eligible expressions are selected by default. Confirmed additions have empty notes and the New stage. Words provides search, stage filtering, note editing, and stage controls. A word appears once its file is saved; an addition the folder refused stays in the field or the review for another try.

A note is saved on leaving its field, and a stage on pressing it with the note as typed, so neither resets the other. Each word opens the folder's row editor on first use, and a save writes the whole word, note and stage together. While the word read from the file differs from the one the note was typed over, nothing is saved on leaving the field and a stage is refused: the note being typed is kept beside the saved one until the learner chooses "Save mine instead" or "Keep the saved note". A save that failed or got no answer stays shown, unknown when unknown, until the learner tries again or keeps the saved word. A file that no longer reads as a word is repaired as exact text, which replaces only the version shown.

Choose one to three saved expressions in Words and start a chat. Vocab saves the chosen focus before requesting a tutor opening. The tutor speaks first, and the learner can follow up. A stopped or failed opening leaves the chat available for explicit retry.

### Saving a phrase

A phrase comes from one line of one finished tutor answer that is saved. Select it with the pointer, the keyboard, or touch handles, or press the answer's "Save a phrase" button and type or paste it. Either way it must be an exact run of that answer's text, trimmed and otherwise unchanged. A selection across two messages or two lines, or in an answer that is still arriving or unsaved, offers nothing. The source is checked again when the phrase is accepted.

The phrase becomes one entry with an empty note and the New stage. "Saved to your words" appears once the folder holds the entry's file. A phrase the folder refused is not added and can be saved again. An exact text that is already in the list is reported as already there, and its note and stage are left alone.

### Chat history

Desktop Chat shows history, conversation, and focus words side by side; narrow Chat offers history and focus controls above the conversation. Returning to Words keeps the selected chat's draft and stream, but closes dictation and discards speech not yet inserted. Switching chats disposes the previous loop and its unsent draft. Focus text stays visible if its saved entry is deleted; its stage control then disappears. Earlier message-only chats remain readable, with their first learner question as the title.

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

A folder an earlier version of Vocab kept in IndexedDB is copied into that directory, files and history together, the first time this version opens it. The old database is only read and stays as a backup. A tab of the earlier version that is still open keeps what it showed, and its saves fail.

A new word's file is named by the SHA-256 of its exact UTF-8 text and created exclusively. Adding one text twice, from one tab or two, or again after an answer that never arrived, reaches the same file: one add creates it and the others find it, with its note and stage as they are. A different file at that name is refused and left alone. An imported word keeps its earlier ID as its file name, so the list is also checked for the text.

A chat's ID is the `chat` field of its messages. A focus item holds the original text and its entry's ID. Messages whose chat has no `chats` file are an earlier message-only chat and are listed without a focus.

A file Vocab cannot read as a row, because its text does not parse or a field does not conform, is listed by path with the reason and left as it is. It is never dropped from view silently.

The app runs the UI-free `@epicenter/agent` loop over one chat's message files. An unsent draft and a partial response are not saved. The selected chat owns the only live loop.

A save is confirmed by the folder's receipt for that file, and nothing is shown as saved before it. Three rules follow:

- The tutor is asked only over saved history. A learner message is a file before generation, and the opening and every retry read the chat's messages from the folder first. A draft stays in the input until its message is saved. A folder that cannot be read asks nothing and has its own "Read again".
- A tutor answer is saved only after a clean finish. A stopped, failed, filtered, or cut-off answer is not saved. A complete answer that the folder refuses stays on screen and copyable; it is not a phrase source until it is saved.
- A failed save has its own notice and its own "Save again", which writes the same file again and never asks the tutor. Tutor failures keep their separate retry. Leaving a chat that holds an unsaved message asks first. The inference picker saves one workflow choice in this browser; an unavailable model leaves Words and history usable.

A message's file is named by its ID and created exclusively, so saving it again adds no second file and a different message at that name is refused.

## Words and chats from earlier Vocab

Earlier versions saved words to the signed-in account's Personal store and chats to a device store whose rows carried an account key. This version opens neither on its own, and nothing is promoted automatically: words and chats from before do not appear until they are imported.

Words has an "Import from earlier Vocab" panel. Signed in, it copies what this browser holds of that account's words and that account's chats into the folder. Each old row becomes the file named by its old row ID, so a focus still names its word, two old words with the same text stay two words with their own notes and stages, and importing again creates nothing and leaves notes and stages edited since as they are. A file already at an old row's name counts as its copy only if it reads as that row; any other file there is left alone and the row is reported as not copied. Vocab writes no row to the earlier stores and deletes nothing from them. Opening them is the ordinary open, so the Personal store connects to the account and its own sync may update this browser's copy. Chats saved under another account in this browser are counted and left where they are.

`src/lib/legacy-import.ts` holds the earlier declarations and the copy; `src/lib/legacy-source.ts` opens the earlier stores and is loaded only when the import is requested.

An ID collision also refuses dependent rows: a chat cannot control a different
word at a focus ID, and its messages cannot join a different chat at its ID.
Refused rows remain in the earlier storage and can be imported again after the
conflict is resolved.

## Development

Start from the repository root with `bun dev:vocab`. Run `bun run --cwd apps/vocab typecheck` and `bun test apps/vocab/src/lib` for focused checks. The tests run the real modules over the real browser folder on an in-memory OPFS stand-in.
