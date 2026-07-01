/**
 * Canonical Epicenter folder: one mount, declared directly at the root.
 *
 * Layout (per specs/20260612T000201-epicenter-namespace-root-layout.md):
 *   epicenter.config.ts            this file: marker + mount factory call
 *   notes/                         markdown projection (committed)
 *   .epicenter/                    machine state (gitignored)
 *     yjs/<id>.db                  Yjs persistence, keyed by ydoc.guid
 *     sqlite/<id>.db               SQL materializer, keyed by ydoc.guid
 *
 * `honeycrisp()` returns a Mount named `honeycrisp`, so `Mount.name` owns the
 * CLI prefix: `honeycrisp.<action_key>` regardless of the folder name. The
 * markdown projection lands in table-named folders under this root
 * (`notes/` for the notes table), and the SQLite mirror is guid-keyed under
 * `.epicenter/sqlite/<id>.db`.
 */

import { honeycrisp } from '@epicenter/honeycrisp/mount';

export default honeycrisp();
