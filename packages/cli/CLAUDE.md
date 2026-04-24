@../../AGENTS.md

# @epicenter/cli

**One-sentence thesis:**

> Introspect and invoke `defineQuery` / `defineMutation` actions in `epicenter.config.ts`, either locally or on a peer that's online right now.

Every command earns its place against that sentence. Before adding a new command or flag, check it with [one-sentence-test](../../.claude/skills/one-sentence-test/SKILL.md) — if it doesn't serve one of the verbs (introspect, invoke) or scopes (local, live-remote), it probably belongs in a user-authored `bun run` script, not here.

## The surface

```
Local domain:         Remote domain:
  list                  peers           (enumeration)
  run                   run --peer      (invocation)

Cross-cutting:
  auth                                  (server session, pre-workspace)
```

- `auth` — session lifecycle against an Epicenter server. Does **not** take `--dir` or `--workspace`; it is pre-config by design.
- `list` — reads local schema only. Peers are never consulted; your config is authoritative about what actions exist.
- `run` — local by default. `--peer <target>` dispatches the same dot-path invocation over the sync room's RPC channel to another client.
- `peers` — remote by construction. `readPeers` filters out the local clientID, so "peer" means "other client in awareness right now." Snapshot, not registry.

## Flag conventions

| Flag | Alias | Commands | Notes |
| ---- | ----- | -------- | ----- |
| `--dir` | `-C` | `list`, `run`, `peers` | Mirrors `git -C`, `pnpm --dir`, `bun --cwd`. |
| `--workspace` | `-w` | `list`, `run`, `peers` | Disambiguates multi-export configs. |
| `--peer` | — | `run` | `deviceName`, numeric `clientID`, or `field=value`. |
| `--timeout` | — | `run --peer` | ms, default 5000. |

Option objects used by 2+ commands live in `src/util/*-option.ts` (see `dir-option`, `workspace-option`). Single-consumer flags stay inline in the command file — don't extract a shared util for symmetry alone.

## Yjs awareness: what `peers` actually returns

Peer enumeration uses Yjs's y-protocols/awareness. Important properties:

- **Ephemeral.** Awareness has a ~30s TTL — peers that crashed silently disappear after the `outdatedTimeout`. It's a liveness probe, not a directory.
- **clientID is session-local.** Re-randomized on every `new Y.Doc()`. Scripts addressing peers by numeric clientID only work within a single presence session.
- **deviceName is a convention, not a guarantee.** Awareness isn't the right substrate for persistent identity (per the Yjs docs). If scripts need stable peer addressing across reconnects, register devices in a shared Y.Map on the doc and use awareness only for liveness.

For interactive CLI use, this is fine. For long-running scripts or production automation that need stable addressing, a doc-registered device list is the correct next step — currently deferred until a concrete use case demands it.

## What does not belong here

- Bulk operations, exports, data transforms → user-authored `bun run scripts/*.ts` that import the config directly.
- Schema discovery over the network → no. `list` is local by design; remote peers are executors, not schema sources.
- Persistent peer identity → no. See Yjs note above.
- Anything that would require the CLI to run a long-lived process — it's strictly one-shot.

## Reference specs

- `specs/20260421T155436-cli-scripting-first-redesign.md` — base surface (auth/list/run), `DocumentBundle` / `DocumentHandle` contract, scripting-first rationale.
- `specs/20260423T174126-cli-remote-peer-rpc.md` — `peers` command and `--peer` flag, RPC over the sync room.
- `specs/20260423T010000-cli-json-only-input.md` — JSON-only input for `run` (deprecates the TypeBox-to-yargs flag bridge).

Older specs describe earlier architectures (HTTP client, command groups, runner merge) and are historical. Treat them as record, not as current design — the four-command surface above is the live model.
