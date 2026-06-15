---
'@epicenter/workspace': minor
'@epicenter/identity': minor
---

Remove the workspace encryption layer now that the sync relay is trusted.

`createWorkspace` and `attachLocalStorage` no longer accept a `keyring`. Stores build a plain `YKeyValueLww` and persist through plain `attachIndexedDb`, keeping the `(server, ownerId)` owner-scoping. `ObservableKvStore` drops its `unreadable` state: the `read()`/`present`/`absent`/`unreadable` surface collapses to `get()`, `has()`, `entries()`, and `size`. `AuthState` (`@epicenter/identity`) drops the `keyring` field from its `signed-in` and `reauth-required` variants; `ownerId` still picks the local storage partition. The `@epicenter/encryption` package it depended on is deleted.

Migration is a one-off manual step. There is no deployed encrypted data, so clear local devices and admin-wipe the Durable Object rooms once. No client IndexedDB name bump is needed.
