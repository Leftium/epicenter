import * as Y from 'yjs';
import { BaseYjsRoom } from './base-room';

/**
 * Durable Object for content documents (text, rich text).
 *
 * Uses `gc: false` to preserve delete history, enabling lightweight metadata
 * snapshots for version history. `Y.snapshot(doc)` returns a state vector +
 * delete set (~7 bytes to ~1.5 KB) that can reconstruct any past doc state
 * from the retained struct store.
 *
 * Auto-saves a snapshot when the last WebSocket disconnects.
 */
export class DocumentRoom extends BaseYjsRoom {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, { gc: false });
	}

	protected override onInit(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS snapshots (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				data BLOB NOT NULL,
				label TEXT,
				created_at TEXT NOT NULL DEFAULT (datetime('now'))
			)
		`);
	}

	protected override onLastDisconnect(): void {
		this.saveSnapshot('Auto-save');
	}

	/** Save a lightweight metadata snapshot of the current doc state. */
	async saveSnapshot(label?: string): Promise<{ id: number; createdAt: string }> {
		const snap = Y.snapshot(this.doc);
		const encoded = Y.encodeSnapshot(snap);
		const { sql } = this.ctx.storage;
		const row = [
			...sql.exec(
				'INSERT INTO snapshots (data, label) VALUES (?, ?) RETURNING id, created_at',
				encoded,
				label ?? null,
			),
		][0]!;
		return { id: row.id as number, createdAt: row.created_at as string };
	}

	/** List all snapshots (metadata only, no reconstruction). */
	async listSnapshots(): Promise<Array<{ id: number; label: string | null; createdAt: string }>> {
		const { sql } = this.ctx.storage;
		return [
			...sql.exec('SELECT id, label, created_at FROM snapshots ORDER BY id DESC'),
		].map((row) => ({
			id: row.id as number,
			label: row.label as string | null,
			createdAt: row.created_at as string,
		}));
	}

	/** Reconstruct a past doc state from a snapshot. Returns full state as binary update. */
	async getSnapshot(snapshotId: number): Promise<Uint8Array | null> {
		const { sql } = this.ctx.storage;
		const rows = [
			...sql.exec('SELECT data FROM snapshots WHERE id = ?', snapshotId),
		];
		if (rows.length === 0) return null;

		const snap = Y.decodeSnapshot(new Uint8Array(rows[0]!.data as ArrayBuffer));
		const restoredDoc = Y.createDocFromSnapshot(this.doc, snap);
		return Y.encodeStateAsUpdateV2(restoredDoc);
	}

	/** Restore a past snapshot's state as the current doc. Saves a "Before restore" snapshot first. */
	async restoreSnapshot(snapshotId: number): Promise<boolean> {
		const past = await this.getSnapshot(snapshotId);
		if (!past) return false;

		await this.saveSnapshot('Before restore');
		Y.applyUpdateV2(this.doc, past, 'restore');
		return true;
	}
}
