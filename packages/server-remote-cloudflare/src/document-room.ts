import * as Y from 'yjs';
import { BaseSyncRoom, createAutoSaveTracker } from './base-sync-room';

/**
 * Durable Object for content documents (`gc: false`).
 *
 * Uses `gc: false` to preserve delete history, enabling lightweight metadata
 * snapshots for version history. `Y.snapshot(doc)` returns a state vector +
 * delete set (~7 bytes to ~1.5 KB) that can reconstruct any past doc state
 * from the retained struct store. Auto-saves a snapshot when the last
 * WebSocket disconnects.
 */
export class DocumentRoom extends BaseSyncRoom {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, { gc: false });

		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS snapshots (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				snapshot BLOB NOT NULL,
				label TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);

		const autoSave = createAutoSaveTracker({
			doc: this.doc,
			save: () => this.saveSnapshot('Auto-save'),
		});

		this.onAllDisconnected(() => autoSave.checkAndSave());
	}

	// --- Snapshot RPCs ---

	/** Save a lightweight metadata snapshot of the current doc state. */
	async saveSnapshot(
		label?: string,
	): Promise<{ id: number; createdAt: string }> {
		const snap = Y.snapshot(this.doc);
		const encoded = Y.encodeSnapshot(snap);
		const row = this.ctx.storage.sql
			.exec(
				'INSERT INTO snapshots (snapshot, label) VALUES (?, ?) RETURNING id, created_at',
				encoded,
				label ?? null,
			)
			.one();
		return { id: row.id as number, createdAt: row.created_at as string };
	}

	/** List all snapshots (metadata only, no reconstruction). */
	async listSnapshots(): Promise<
		Array<{ id: number; label: string | null; createdAt: string }>
	> {
		return this.ctx.storage.sql
			.exec('SELECT id, label, created_at FROM snapshots ORDER BY id DESC')
			.toArray()
			.map((row) => ({
				id: row.id as number,
				label: row.label as string | null,
				createdAt: row.created_at as string,
			}));
	}

	/** Reconstruct a past doc state from a snapshot. Returns full state as binary update. */
	async getSnapshot(snapshotId: number): Promise<Uint8Array | null> {
		const rows = this.ctx.storage.sql
			.exec('SELECT snapshot FROM snapshots WHERE id = ?', snapshotId)
			.toArray();
		if (rows.length === 0) return null;

		const snap = Y.decodeSnapshot(
			new Uint8Array(rows[0]!.snapshot as ArrayBuffer),
		);
		const restoredDoc = Y.createDocFromSnapshot(this.doc, snap);
		return Y.encodeStateAsUpdateV2(restoredDoc);
	}

	/**
	 * Merge a past snapshot's content into the current doc.
	 *
	 * This is a CRDT forward-merge, not a destructive rollback. The snapshot's
	 * content is re-applied as a new update, so the doc grows slightly as items
	 * from the snapshot re-enter the struct store. All edits made after the
	 * snapshot are preserved — they coexist with the restored content via CRDT
	 * conflict resolution.
	 *
	 * Saves a "Before restore" safety snapshot before applying.
	 */
	async applySnapshot(snapshotId: number): Promise<boolean> {
		const past = await this.getSnapshot(snapshotId);
		if (!past) return false;

		await this.saveSnapshot('Before restore');
		Y.applyUpdateV2(this.doc, past, 'restore');
		return true;
	}
}
