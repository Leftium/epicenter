# Whispering App

A standalone Tauri desktop app. Recordings, transcripts, and settings are files
in one Git-versioned folder; those files are the data. Read `README.md` for
behavior and `ARCHITECTURE.md` for structure before changing either.

## Constraints

- **The page stays native-free.** Nothing under `src/` imports a Node, Bun, or
  Tauri module, or `@epicenter/app/files/native`. The page reaches the folder
  only through `src/lib/workspace/`. `src/lib/page-boundary.test.ts` enforces
  this; keep it passing and do not weaken it.
- **One session per mounted layout.** `src/routes/+layout.svelte` opens the
  session and `AppShell` puts it in context. A page or component takes it with
  `getSession()`; it never opens a workspace, builds a library, or keeps
  product state in a module-level variable. State that must survive a page
  change belongs to the session. Only leaving the app is guarded, never a
  navigation between routes. `src/lib/page-boundary.test.ts` enforces the
  ownership.
- **Native work belongs in `native/`.** The folder host is the only process that
  touches the data folder. Add a host operation there and expose it through the
  workspace type, with a browser implementation or an explicit `undefined`.
- **The shell registers no commands.** Do not add a Tauri command or capability
  to give the page a native ability. Load the `tauri` skill before changing
  `src-tauri/`.
- **The shell never closes on its own judgement.** Every window close and exit
  request goes through the close handshake (`ARCHITECTURE.md`, "Closing"). Do
  not add a path that exits without the page's answer, and do not rely on the
  browser's leave warning in the desktop app.
- **Files are authoritative.** Do not add a cache, mirror, or second store of
  recordings. Do not add Yjs, the `@epicenter/app` store, accounts, or sync to
  this workflow.
- **A save is never reported by its commit.** Keep saved-file state and history
  state separate in code and in copy.
- **Never overwrite to recover.** Recovery writes only what is missing, as an
  exclusive creation, and refuses when a path holds something it did not write.
- **Fixture audio and failure injection are debug-only.** They are enabled by
  the shell's build, never by an environment variable alone, and the UI says so
  while they are active.
- **A transformation never writes its transcript.** A result is a new row in
  `transformation_runs/` with a stem fixed before the request is sent. Saving a
  received result again must not call the endpoint or create a second file.
- **The API key stays in the host.** It is never returned over the bridge,
  logged, or written to the folder, including inside an error message.
- **Nothing is sent or seeded on its own.** No request leaves at launch or
  after a recording without the person asking, and no file is created in the
  folder that they did not create, apart from `kv.json`.
- Do not rename a recording's or a transformation's files from the app: other
  rows refer to the stem.
- Use wellcrafted `Result` types instead of try-catch for expected failures.

## Checks

From `apps/whispering`: `bun run typecheck`, `bun test --isolate`,
`bun run build`. For shell changes also
`cargo test --manifest-path src-tauri/Cargo.toml`. Tests establish logic and
what reaches disk; only running `bun dev:whispering` establishes that the
desktop app works.

`src/lib/tauri/bindings.gen.ts` is written by the Epicenter host's build and
read by its Rust tests. Do not edit, import, or delete it from here.
