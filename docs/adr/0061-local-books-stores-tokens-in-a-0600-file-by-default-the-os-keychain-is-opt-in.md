# 0061. Local Books stores OAuth tokens in a 0600 file by default; the OS keychain is opt-in

- **Status:** Accepted
- **Date:** 2026-06-25

## Context

Local Books is a headless CLI (ADR-0047 makes its mirror an agent-facing data daemon); its recurring mode is unattended `sync`, run from cron or a detached session. The original token store made the interactive OS keychain the mandatory default, reached by spawning the platform credential CLI (`security` on macOS, `secret-tool` on Linux). That keychain needs a graphic security session, so under SSH, tmux, or herdr the read fails with `errSecInteractionNotAllowed` (exit 36), and the macOS backend silently mapped that non-zero exit to `null` = "no token stored," which reads as "logged out" and triggers a surprise re-auth. Research into the failure and into comparable CLIs settled two facts: the subprocess was never the root cause (a native binding hits the same OS gate), and a 0600 file as the default with the keychain as an opt-in is the mainstream posture (AWS, gcloud, Codex, `git credential-store`), not a compromise.

## Decision

OAuth tokens default to a `0600` `credentials.json` at the data-dir root, kept out of any company's mirror db so the agent's read-only SQL surface (`books_sql_query`) can never read them. This file store works identically on a desktop, a headless server, an SSH session, and CI.

The OS keychain stays available as an opt-in (`LOCAL_BOOKS_KEYRING=keychain`), reached through `Bun.secrets`: native, no subprocess, and still inside the single `bun build --compile` binary because the API is built into the Bun runtime. The two spawn-based backends are deleted.

The store is modeled as one resolved value, `TokenStore = { path: string } | 'keychain'`, not a flag cross-product: having a path means a file, the bare `'keychain'` token means the keychain, so "the keychain, at a file path" cannot be expressed. Resolution happens once (`resolveTokenStore`): an explicit `LOCAL_BOOKS_KEYRING_FILE` wins, then the keychain opt-in, else the default file.

## Consequences

- The recurring mode (unattended sync over SSH/herdr/CI) works with zero configuration, which is the whole point of a headless-first tool. The previous design literally could not run there without the operator knowing an env var.
- Error semantics are honest: a backend throws when the store is unreachable or locked, and returns `null` only when nothing is stored. A locked keychain can no longer masquerade as "logged out."
- No subprocess means no CLI-existence or `PATH` assumption, and the single dependency-free binary is preserved (the keychain path adds zero npm dependencies).
- The default file is plaintext at rest; the file mode is the protection, the same tradeoff `git credential-store` and `~/.aws/credentials` make. The keychain's one real edge over a 0600 file (containment from backup / cloud-sync sweeps) is given up on the default path; it is recoverable by opting into the keychain, or later by optional file encryption, which would be a non-breaking addition.

## Considered alternatives

- **Swap the subprocess for a native credential library (`keytar`, `@napi-rs/keyring`).** Rejected: it does not fix the failure (the OS gates session-less keychain access regardless of caller), and a native `.node` addon fights `bun build --compile` and adds a dependency. `Bun.secrets` is the only native option that keeps the dependency-free single binary.
- **Keep the keychain as the default with an automatic file fallback (the `gh` / Infisical model).** Rejected as the default for a headless-first tool: the file default is simpler, and the keychain's benefit is desktop-only and marginal here.
- **Two flat config fields (`keyringFile` + `keyringBackend`).** Rejected: it expresses a contradictory state (a file path plus a keychain selection) and arbitrates the choice in two places. One discriminated value makes the illegal state unrepresentable.
- **Delete the keychain entirely (file-only).** Viable and more minimal, but the keychain costs about a dozen lines through the built-in `Bun.secrets` and serves desktop users who want OS-managed storage, so it is kept as a clean opt-in rather than removed.

## Reference

- Implemented in `apps/local-books/src/keyring.ts` (`TokenStore`, `createKeyring`, `createFileKeyring`, `createKeychainKeyring`), `src/config.ts` (`resolveTokenStore`), and `src/paths.ts` (`credentialsFilePath`). Builds on ADR-0047 (the mirror as a data daemon) and ADR-0060 (the agent surface whose SQL read this store stays clear of).
