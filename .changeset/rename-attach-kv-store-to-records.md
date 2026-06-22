---
'@epicenter/workspace': minor
---

Rename the `attachKvStore` child-doc layout to `attachRecords`, and its handle type `KvStoreHandle` to `RecordsHandle`. The keyed last-write-wins record store now sits with `attachRichText` and `attachPlainText` as a child-doc body layout, rather than in the `defineKv` / `createKv` settings family it never belonged to. The substrate types (`YKeyValueLww`, `ObservableKvStore`, `KvEntry`, `KvStoreChange`) keep their names, and the backing array slot stays `'entries'`, so synced documents are unaffected.
