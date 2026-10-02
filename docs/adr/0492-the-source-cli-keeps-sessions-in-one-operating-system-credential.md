# 0492. The source CLI keeps sessions in one operating system credential

- **Status:** Proposed
- **Date:** 2026-10-02
- **Implementation:** Source CLI account commands and private credential owner; hosted callback deployment and real OS credential acceptance remain pending.

## Context

The CLI needs its own sessions so login can select local account data without downloading files or configuring Git. Desktop credentials belong to the desktop process. Reusing that process or its keyring cell would make standalone CLI use depend on another app.

Bun 1.3.14 already exposes the operating system credential APIs. A separate native helper would add a build, process lifetime, and pipe protocol around capabilities the CLI runtime already owns. A plaintext identity index would introduce a second collection whose membership can disagree with the credentials.

## Decision

The source CLI owns one credential at service `so.epicenter.cli-source`, name `sessions`. It uses `Bun.secrets` and stores a versioned collection of authority, principal, issuer metadata, and session token. A missing credential means no saved sessions. An unreadable collection or unavailable credential store is an error. Login leaves that state untouched rather than replacing it with an empty collection. There is no plaintext fallback.

A private SQLite exclusive transaction serializes each read, merge, conditional update, write, and confirmation on one computer. The lock database holds no credentials. The owner waits asynchronously for contention and holds no lock across the browser ceremony or network revocation. Every update rereads the collection under the lock, so adding an account preserves accounts added by another CLI process.

The collection has a conservative 2048-byte UTF-8 limit. Capacity refusal happens before writing. A write is read back. If its outcome is uncertain, the owner checks again and attempts to restore the preceding value; it reports uncertainty if restoration cannot be confirmed. This is coordination around an OS store, not a transaction spanning SQLite and that store.

Login reuses the session handoff and session auth owners. The CLI receives one verified session and merges it into the collection. Cancellation removes or restores only that attempt's token; a newer token for the same account survives. The browser opener does not own sign-in completion and cannot keep a successful CLI process alive. The CLI does not terminate a browser on cancellation.

Logout captures one account's token, conditionally removes it, and then attempts bounded revocation. Failed removal or a stale token does not trigger revocation. An issuer recorded in private storage is metadata, never an automatic network destination. This implementation contacts only the fixed Cloud descriptor. Other saved issuers can be listed and removed locally without sending their credentials anywhere.

`accounts` derives portable paths from cached identity without network access or data-folder writes. Local discovery, Local Git, and validation do not load the credential owner. No active-account pointer, application enrollment, folder installation index, or login-time transfer is stored.

## Consequences

- Sessions stay outside portable data folders and Git history. Each app and the CLI owns its own login lifetime.
- Offline account listing requires access to the OS credential store. Corruption affects the collection; the CLI reports the credential address for explicit OS-level recovery.
- The size limit bounds the saved account count. It does not create another entry or silently drop an account.
- Bun's secrets API is experimental. Its use is confined to the credential owner. A compiled CLI must establish its own credential identity and acceptance rather than assuming source-runtime continuity.
- Bun 1.3.14 uses enterprise persistence on Windows. OS roaming can carry the entry between computers; the local lock does not coordinate those copies. [Versioned Windows implementation](https://github.com/oven-sh/bun/blob/bun-v1.3.14/src/jsc/bindings/SecretsWindows.cpp).
- Unexpected process death or an OS-store failure can leave a write's outcome unknown. Logout success confirms local removal, not server revocation.
- Tests use a fake secret cell with real SQLite, loopback transport, and actual CLI signal cancellation. They do not establish OS prompt behavior or packaged credential continuity.

## Considered alternatives

- **Standalone Rust credential helper.** It can own an OS store, but the trusted source CLI has no WebView boundary that requires another process. Bun's native API removes the crate, build step, and JSON protocol.
- **One secret per account with a plaintext identity list.** It isolates entry corruption and expands capacity, but introduces cross-store ordering, stale membership, and recovery rules. Listing without a keychain read does not earn that machinery for this milestone.
- **Use the desktop auth cell.** It couples independent sessions and requires the desktop host to be installed or running.
- **Remove whichever token is current at logout time.** That can remove a newer login that finished after the command selected its session. Captured-token comparison preserves that newer session.
- **Drop cancellation rollback and save directly.** This shrinks the adapter but withdraws the promised cancellation behavior. The existing session owner retains verification and rollback without another auth protocol.
