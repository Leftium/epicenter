/**
 * Import a legacy bundle into a capture folder as ordinary Markdown files.
 *
 * The import reads a bundle, never the old store. It writes only new files
 * and never replaces one:
 *
 *   captures/legacy-<account>-c-<hash>.md   one old capture with its thoughts
 *   captures/legacy-<account>-e-<hash>.md   one old entry
 *   captures/legacy-<account>-o-<hash>.md   thoughts whose capture is absent
 *   captures/legacy-<account>-l-<hash>.md   thoughts that arrived after their
 *                                           capture was imported
 *   recovery/legacy-export-<account>-<bundle>.json   the bundle itself
 *   recovery/legacy-report-<account>-<bundle>.md     what could not be read
 *   recovery/legacy-import-receipt-<account>.json    what has been imported
 *
 * `<account>` is a hash of the authority and principal, so two accounts
 * importing into one folder never share a file name or a receipt.
 *
 * Retrying is safe because every destination is derived from the old row's
 * ID, files are created exclusively, and the receipt is written after the
 * files. For each planned document:
 *
 * - The receipt names its source: skipped, even if the file was since edited
 *   or deleted. Deleting an imported capture does not bring it back.
 * - The destination is absent: created, then recorded.
 * - The destination holds the same bytes (an earlier run wrote the file and
 *   stopped before the receipt): recorded.
 * - The destination holds other bytes: reported, left alone, not recorded.
 *
 * There are no hidden tombstones. Deleting the receipt makes the next import
 * treat every source as new. `README.md` states these bounds.
 */
import type { FileCapture, FolderFiles } from '@epicenter/folder';
import { CAPTURES_TABLE } from '../definition.js';
import { composeBody, type Refusal } from '../document.js';
import {
	accountTagOf,
	bundleIdOf,
	type LegacyAccount,
	type LegacyBundle,
	type LegacyThought,
	serializeLegacyBundle,
	sha256Hex,
} from './bundle.js';

export const RECEIPT_FORMAT = 'epicenter.capture.legacy-import-receipt';
export const RECOVERY_DIRECTORY = 'recovery';

export type ReceiptRecord = {
	readonly path: string;
	readonly sha256: string;
	readonly bundleId: string;
	/** The old thought rows this document carries. */
	readonly thoughtIds: readonly string[];
};

export type ImportReceipt = {
	readonly format: typeof RECEIPT_FORMAT;
	readonly version: 1;
	readonly account: LegacyAccount;
	/** Keyed by source identity, e.g. `captures/<id>`. */
	readonly imports: Readonly<Record<string, ReceiptRecord>>;
};

export type PlannedDocument = {
	/** The old source this document stands for. */
	readonly identity: string;
	readonly kind: 'capture' | 'entry' | 'orphan-thoughts' | 'late-thoughts';
	readonly path: string;
	readonly source: string;
	readonly sha256: string;
	readonly thoughtIds: readonly string[];
	/** Why the app's structured view cannot read this document, when it cannot. */
	readonly structured: Refusal | undefined;
};

/** What the bundle held that no document carries. Derived from the bundle alone. */
export type ImportDiagnostics = {
	/** Rows whose stored values could not be read; their raw values are in the report. */
	readonly unreadableRows: number;
	/** Rows whose body could not be read. Not imported and not recorded, so a later export can bring them. */
	readonly unreadableBodies: readonly { table: string; id: string }[];
	/** Thoughts with an empty body: nothing to write. */
	readonly emptyThoughts: readonly string[];
	/** Thoughts left out because their capture's body could not be read. */
	readonly heldThoughts: readonly string[];
	readonly promotionCount: number;
};

export type ImportPlan = {
	readonly bundleId: string;
	readonly accountTag: string;
	readonly documents: readonly PlannedDocument[];
	/** Sources the receipt already names. */
	readonly alreadyImported: readonly string[];
	readonly diagnostics: ImportDiagnostics;
	readonly bundlePath: string;
	readonly reportPath: string;
	readonly reportSource: string;
	readonly receiptPath: string;
};

const byOrder = (left: LegacyThought, right: LegacyThought) =>
	left.position - right.position ||
	(left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const capturePath = (stem: string) => `${CAPTURES_TABLE}/${stem}.md`;

/** A plain YAML scalar when it is a datetime, a quoted string otherwise. */
const yamlInstant = (value: string) =>
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
		value,
	)
		? value
		: JSON.stringify(value);

function compose(
	frontmatter: readonly (readonly [string, string])[],
	text: string,
	thoughts: readonly string[],
): { source: string; structured: Refusal | undefined } {
	const head = frontmatter.map(([key, value]) => `${key}: ${value}\n`).join('');
	// The composer a new capture uses, so imported text with its own Thoughts
	// heading or an open fence is kept whole and stays source-only.
	const composed = composeBody(text, thoughts);
	return {
		source: `---\n${head}---\n${composed.body}`,
		structured:
			composed.refusal ??
			(composed.absorbed
				? {
						code: 'unverified',
						message:
							'The original text holds Markdown, such as an unclosed code fence, that absorbs the Thoughts section.',
					}
				: undefined),
	};
}

/** A fence long enough to hold `text` verbatim. */
function fenced(text: string, info = ''): string {
	const longest = Math.max(
		2,
		...[...text.matchAll(/`+/g)].map((run) => run[0].length),
	);
	const fence = '`'.repeat(longest + 1);
	return `${fence}${info}\n${text}\n${fence}\n`;
}

function reportOf(
	bundle: LegacyBundle,
	bundleId: string,
	bundlePath: string,
	diagnostics: ImportDiagnostics,
	held: readonly LegacyThought[],
): string {
	const { account } = bundle.source;
	const lines: string[] = [
		'# Capture import report',
		'',
		`- Export made: ${bundle.exportedAt}`,
		`- Account: ${account.authorityId} / ${account.principalId}`,
		`- Bundle: ${bundleId} (${bundlePath})`,
		`- In the bundle: ${bundle.captures.length} captures, ${bundle.thoughts.length} thoughts, ${bundle.entries.length} earlier entries`,
		'',
		'The export is what one device held when it was made. Rows that had not',
		'reached that device are not in it, and the export cannot tell. Export',
		'again later to pick them up; the receipt keeps the second import from',
		'duplicating the first.',
		'',
		'## Bodies that could not be read',
		'',
	];
	if (diagnostics.unreadableBodies.length === 0) lines.push('None.', '');
	else {
		lines.push(
			'These rows exist, but their text was not available on the device. They',
			'were not imported and not recorded, so a later export can bring them.',
			'This is different from an empty body.',
			'',
			...diagnostics.unreadableBodies.map((row) => `- ${row.table}/${row.id}`),
			'',
		);
	}
	lines.push('## Thoughts held back with their capture', '');
	if (held.length === 0) lines.push('None.', '');
	else {
		lines.push(
			'The capture these belong to had no readable text, so they were not',
			'imported. Their text is kept here.',
			'',
		);
		for (const thought of held)
			lines.push(
				`### thoughts/${thought.id} (capture ${thought.captureId}, position ${thought.position})`,
				'',
				thought.text === null
					? 'Body could not be read.\n'
					: fenced(thought.text),
			);
	}
	lines.push('## Empty thoughts left out', '');
	lines.push(
		diagnostics.emptyThoughts.length === 0
			? 'None.'
			: diagnostics.emptyThoughts.map((id) => `- thoughts/${id}`).join('\n'),
		'',
		'## Rows that could not be read',
		'',
	);
	if (bundle.unreadable.length === 0) lines.push('None.', '');
	for (const row of bundle.unreadable) {
		lines.push(`### ${row.table}/${row.id}`, '');
		for (const issue of row.issues) lines.push(`- ${issue}`);
		lines.push(
			'',
			'Stored values:',
			'',
			fenced(JSON.stringify(row.raw, null, 2), 'json'),
			row.text === null
				? 'Body could not be read.\n'
				: `Body:\n\n${fenced(row.text)}`,
		);
	}
	lines.push(
		'## Not exported',
		'',
		`${bundle.promotionCount} request records from the old Whispering handoff. They held request IDs, not writing.`,
		'',
	);
	return lines.join('\n');
}

/**
 * Decide what an import of this bundle writes, given what the receipt says
 * was already imported. Pure: the same bundle and receipt give the same plan.
 */
export async function planLegacyImport(
	bundle: LegacyBundle,
	receipt: ImportReceipt | undefined,
): Promise<ImportPlan> {
	const bundleId = await bundleIdOf(bundle);
	const accountTag = await accountTagOf(bundle.source.account);
	const records = receipt?.imports ?? {};
	const stem = async (kind: string, identity: string) =>
		`legacy-${accountTag}-${kind}-${(await sha256Hex(identity)).slice(0, 20)}`;
	const origin = (identity: string) =>
		JSON.stringify(`${bundle.source.storeId}/${identity}`);

	const documents: PlannedDocument[] = [];
	const alreadyImported: string[] = [];
	async function plan(
		document: Omit<PlannedDocument, 'sha256' | 'structured'> & {
			structured: Refusal | undefined;
		},
	) {
		if (Object.hasOwn(records, document.identity)) {
			alreadyImported.push(document.identity);
			return;
		}
		documents.push({ ...document, sha256: await sha256Hex(document.source) });
	}

	const byCapture = new Map<string, LegacyThought[]>();
	for (const thought of bundle.thoughts) {
		const group = byCapture.get(thought.captureId) ?? [];
		group.push(thought);
		byCapture.set(thought.captureId, group);
	}
	for (const group of byCapture.values()) group.sort(byOrder);
	const readable = (thoughts: readonly LegacyThought[]) =>
		thoughts.filter(
			(thought): thought is LegacyThought & { text: string } =>
				thought.text !== null && thought.text.trim() !== '',
		);
	/** Thought rows some earlier document for this capture already carries. */
	const carried = (captureId: string) => {
		const ids = new Set<string>();
		for (const [identity, record] of Object.entries(records))
			if (
				identity === `captures/${captureId}` ||
				identity === `orphans/${captureId}` ||
				identity.startsWith(`late/${captureId}/`)
			)
				for (const id of record.thoughtIds) ids.add(id);
		return ids;
	};

	const unreadableBodies: { table: string; id: string }[] = [];
	const held: LegacyThought[] = [];
	const captureIds = new Set(bundle.captures.map((capture) => capture.id));

	for (const capture of bundle.captures) {
		const thoughts = byCapture.get(capture.id) ?? [];
		if (capture.text === null) {
			unreadableBodies.push({ table: 'captures', id: capture.id });
			held.push(...thoughts);
			continue;
		}
		const identity = `captures/${capture.id}`;
		const kept = readable(thoughts);
		const existing = records[identity];
		if (existing !== undefined) {
			alreadyImported.push(identity);
			// Thoughts that reached the device after their capture was imported
			// become their own document; the imported capture is not patched.
			const seen = carried(capture.id);
			const late = kept.filter((thought) => !seen.has(thought.id));
			if (late.length === 0) continue;
			const lateIdentity = `late/${capture.id}/${(
				await sha256Hex(late.map((thought) => thought.id).join('\n'))
			).slice(0, 16)}`;
			const composed = compose(
				[
					['capturedAt', yamlInstant(bundle.exportedAt)],
					['capturedAtIs', '"export time, not when these were written"'],
					['importedFrom', origin(lateIdentity)],
				],
				`Thoughts recovered after their capture was imported.\n\nThey belong to the capture imported as \`${existing.path}\` (old ID \`${capture.id}\`). The date above is when the export was made, not when they were written.\n\nOld thought IDs, in order: ${late.map((thought) => thought.id).join(', ')}`,
				late.map((thought) => thought.text),
			);
			await plan({
				identity: lateIdentity,
				kind: 'late-thoughts',
				path: capturePath(await stem('l', lateIdentity)),
				source: composed.source,
				thoughtIds: late.map((thought) => thought.id),
				structured: composed.structured,
			});
			continue;
		}
		const composed = compose(
			[
				['capturedAt', yamlInstant(capture.capturedAt)],
				['importedFrom', origin(identity)],
			],
			capture.text,
			kept.map((thought) => thought.text),
		);
		await plan({
			identity,
			kind: 'capture',
			path: capturePath(await stem('c', identity)),
			source: composed.source,
			thoughtIds: kept.map((thought) => thought.id),
			structured: composed.structured,
		});
	}

	for (const [captureId, thoughts] of byCapture) {
		if (captureIds.has(captureId)) continue;
		const seen = carried(captureId);
		const kept = readable(thoughts).filter((thought) => !seen.has(thought.id));
		const first = !Object.hasOwn(records, `orphans/${captureId}`);
		if (!first) alreadyImported.push(`orphans/${captureId}`);
		if (kept.length === 0) continue;
		const identity = first
			? `orphans/${captureId}`
			: `late/${captureId}/${(
					await sha256Hex(kept.map((thought) => thought.id).join('\n'))
				).slice(0, 16)}`;
		const composed = compose(
			[
				['capturedAt', yamlInstant(bundle.exportedAt)],
				['capturedAtIs', '"export time, not when these were written"'],
				['importedFrom', origin(identity)],
			],
			`Recovered thoughts without their capture.\n\nThe capture they belong to (old ID \`${captureId}\`) was not in the export, so its text and date are unknown. The date above is when the export was made, not when these were written.\n\nOld thought IDs, in order: ${kept.map((thought) => thought.id).join(', ')}`,
			kept.map((thought) => thought.text),
		);
		await plan({
			identity,
			kind: first ? 'orphan-thoughts' : 'late-thoughts',
			path: capturePath(await stem(first ? 'o' : 'l', identity)),
			source: composed.source,
			thoughtIds: kept.map((thought) => thought.id),
			structured: composed.structured,
		});
	}

	for (const entry of bundle.entries) {
		if (entry.text === null) {
			unreadableBodies.push({ table: 'entries', id: entry.id });
			continue;
		}
		const identity = `entries/${entry.id}`;
		const composed = compose(
			[
				['capturedAt', yamlInstant(entry.capturedAt)],
				['importedFrom', origin(identity)],
				...(entry.parentId === null
					? []
					: [['legacyParentId', JSON.stringify(entry.parentId)] as const]),
			],
			entry.text,
			[],
		);
		await plan({
			identity,
			kind: 'entry',
			path: capturePath(await stem('e', identity)),
			source: composed.source,
			thoughtIds: [],
			structured: composed.structured,
		});
	}

	for (const thought of bundle.thoughts)
		if (thought.text === null && !held.includes(thought))
			unreadableBodies.push({ table: 'thoughts', id: thought.id });

	const diagnostics: ImportDiagnostics = {
		unreadableRows: bundle.unreadable.length,
		unreadableBodies,
		emptyThoughts: bundle.thoughts
			.filter((thought) => thought.text !== null && thought.text.trim() === '')
			.map((thought) => thought.id),
		heldThoughts: held.map((thought) => thought.id),
		promotionCount: bundle.promotionCount,
	};
	const bundlePath = `${RECOVERY_DIRECTORY}/legacy-export-${accountTag}-${bundleId}.json`;
	return {
		bundleId,
		accountTag,
		documents,
		alreadyImported,
		diagnostics,
		bundlePath,
		reportPath: `${RECOVERY_DIRECTORY}/legacy-report-${accountTag}-${bundleId}.md`,
		reportSource: reportOf(bundle, bundleId, bundlePath, diagnostics, held),
		receiptPath: `${RECOVERY_DIRECTORY}/legacy-import-receipt-${accountTag}.json`,
	};
}

// ============================================================================
// Running an import
// ============================================================================

export type DocumentOutcome = {
	readonly identity: string;
	readonly kind: PlannedDocument['kind'];
	readonly path: string;
	readonly structured: Refusal | undefined;
} & (
	| { readonly status: 'created' }
	/** The file was already there with the same bytes. */
	| { readonly status: 'identical' }
	/** Another file is there. It was left alone and nothing was recorded. */
	| { readonly status: 'differs' }
	| { readonly status: 'failed'; readonly message: string }
);

export type ImportReport = {
	readonly bundleId: string;
	readonly bundlePath: string;
	readonly reportPath: string;
	readonly receiptPath: string;
	readonly documents: readonly DocumentOutcome[];
	readonly alreadyImported: readonly string[];
	readonly diagnostics: ImportDiagnostics;
	/** A file other than a capture that could not be written. */
	readonly problems: readonly string[];
	readonly receipt:
		| { readonly status: 'written' | 'unchanged' }
		| { readonly status: 'failed'; readonly message: string };
	/**
	 * Every planned document is in place and recorded. When false, run the same
	 * bundle again after resolving what is listed; nothing is duplicated.
	 */
	readonly complete: boolean;
};

/**
 * The file verbs the import uses. `create` is exclusive, and `replace` lands
 * only over the exact receipt that was read; nothing here can overwrite.
 */
export type ImportFiles = Pick<FolderFiles, 'read' | 'create' | 'replace'>;

const decoder = new TextDecoder('utf-8', { fatal: true });

/** Create `path` with `source`, or say what is there instead. Never overwrites. */
async function createExclusive(
	files: ImportFiles,
	path: string,
	source: string,
): Promise<
	| { status: 'created' | 'identical' | 'differs' }
	| { status: 'failed'; message: string }
> {
	try {
		const { error: writeError } = await files.create(path, source);
		if (writeError === null) return { status: 'created' };
		if (writeError.name !== 'Exists')
			return { status: 'failed', message: writeError.message };
		const { data: existing, error: readError } = await files.read(path);
		if (readError !== null)
			return { status: 'failed', message: readError.message };
		try {
			return {
				status:
					decoder.decode(existing.bytes) === source ? 'identical' : 'differs',
			};
		} catch {
			return { status: 'differs' };
		}
	} catch (cause) {
		return {
			status: 'failed',
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
}

type ReceiptRead =
	| {
			ok: true;
			receipt: ImportReceipt | undefined;
			/** The receipt file as it was read; `undefined` when there is none yet. */
			file: FileCapture | undefined;
	  }
	| { ok: false; message: string };

async function readReceipt(
	files: ImportFiles,
	path: string,
	account: LegacyAccount,
): Promise<ReceiptRead> {
	const { data: file, error } = await files.read(path);
	if (error !== null)
		return error.name === 'NotFound'
			? { ok: true, receipt: undefined, file: undefined }
			: { ok: false, message: error.message };
	try {
		const value = JSON.parse(decoder.decode(file.bytes)) as ImportReceipt;
		const imports = value?.imports;
		if (
			value?.format !== RECEIPT_FORMAT ||
			value.version !== 1 ||
			value.account?.authorityId !== account.authorityId ||
			value.account?.principalId !== account.principalId ||
			typeof imports !== 'object' ||
			imports === null ||
			Array.isArray(imports) ||
			!Object.values(imports).every(
				(record) =>
					typeof record?.path === 'string' &&
					typeof record.sha256 === 'string' &&
					/^[a-f0-9]{64}$/.test(record.sha256) &&
					typeof record.bundleId === 'string' &&
					/^[a-f0-9]{16}$/.test(record.bundleId) &&
					Array.isArray(record.thoughtIds) &&
					record.thoughtIds.every((id) => typeof id === 'string'),
			)
		)
			return {
				ok: false,
				message: `${path} is not an import receipt for this account.`,
			};
		return {
			ok: true,
			receipt: value,
			file: { path: file.path, sha256: file.sha256 },
		};
	} catch (cause) {
		return {
			ok: false,
			message: `${path} cannot be read as an import receipt: ${cause instanceof Error ? cause.message : String(cause)}`,
		};
	}
}

function serializeReceipt(
	account: LegacyAccount,
	imports: Readonly<Record<string, ReceiptRecord>>,
): string {
	const sorted: Record<string, ReceiptRecord> = {};
	for (const identity of Object.keys(imports).sort()) {
		const record = imports[identity] as ReceiptRecord;
		sorted[identity] = {
			path: record.path,
			sha256: record.sha256,
			bundleId: record.bundleId,
			thoughtIds: [...record.thoughtIds],
		};
	}
	return `${JSON.stringify(
		{
			format: RECEIPT_FORMAT,
			version: 1,
			account: {
				authorityId: account.authorityId,
				principalId: account.principalId,
			},
			imports: sorted,
		},
		null,
		'\t',
	)}\n`;
}

/**
 * Import a bundle. Rejects only when nothing was written: the receipt for
 * this account cannot be read, or the bundle's own file name is taken by
 * other bytes. Everything after that is reported, not thrown.
 */
export async function runLegacyImport(
	files: ImportFiles,
	bundle: LegacyBundle,
): Promise<ImportReport> {
	const { account } = bundle.source;
	const receiptPath = `${RECOVERY_DIRECTORY}/legacy-import-receipt-${await accountTagOf(account)}.json`;
	const before = await readReceipt(files, receiptPath, account);
	if (!before.ok)
		throw new Error(
			`Nothing was imported. ${before.message} The receipt is what keeps a retry from importing twice, so fix or remove it first.`,
		);
	const plan = await planLegacyImport(bundle, before.receipt);

	const saved = await createExclusive(
		files,
		plan.bundlePath,
		serializeLegacyBundle(bundle),
	);
	if (saved.status === 'differs' || saved.status === 'failed')
		throw new Error(
			`Nothing was imported. The export could not be saved at ${plan.bundlePath}${saved.status === 'failed' ? `: ${saved.message}` : ': another file is there.'}`,
		);

	const documents: DocumentOutcome[] = [];
	const recorded: Record<string, ReceiptRecord> = {};
	for (const document of plan.documents) {
		const outcome = await createExclusive(
			files,
			document.path,
			document.source,
		);
		documents.push({
			identity: document.identity,
			kind: document.kind,
			path: document.path,
			structured: document.structured,
			...outcome,
		});
		if (outcome.status === 'created' || outcome.status === 'identical')
			recorded[document.identity] = {
				path: document.path,
				sha256: document.sha256,
				bundleId: plan.bundleId,
				thoughtIds: document.thoughtIds,
			};
	}

	const problems: string[] = [];
	const report = await createExclusive(
		files,
		plan.reportPath,
		plan.reportSource,
	);
	if (report.status === 'differs')
		problems.push(
			`The report was not written: another file is at ${plan.reportPath}.`,
		);
	if (report.status === 'failed')
		problems.push(`The report was not written: ${report.message}`);

	// Files first, then the receipt. A failure here leaves files the next run
	// finds identical and records.
	let receipt: ImportReport['receipt'] = { status: 'unchanged' };
	if (Object.keys(recorded).length > 0) {
		receipt = { status: 'failed', message: 'The receipt kept changing.' };
		let current = before;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const next = serializeReceipt(account, {
					...current.receipt?.imports,
					...recorded,
				});
				// Only over the receipt that was read, or where none was found.
				const { error: writeError } =
					current.file === undefined
						? await files.create(receiptPath, next)
						: await files.replace(current.file, next);
				if (writeError === null) {
					receipt = { status: 'written' };
					break;
				}
				receipt = { status: 'failed', message: writeError.message };
				if (
					writeError.name !==
					(current.file === undefined ? 'Exists' : 'Conflict')
				)
					break;
				const reread = await readReceipt(files, receiptPath, account);
				if (!reread.ok) {
					receipt = { status: 'failed', message: reread.message };
					break;
				}
				current = reread;
			} catch (cause) {
				receipt = {
					status: 'failed',
					message: cause instanceof Error ? cause.message : String(cause),
				};
				break;
			}
		}
	}

	return {
		bundleId: plan.bundleId,
		bundlePath: plan.bundlePath,
		reportPath: plan.reportPath,
		receiptPath,
		documents,
		alreadyImported: plan.alreadyImported,
		diagnostics: plan.diagnostics,
		problems,
		receipt,
		complete:
			receipt.status !== 'failed' &&
			problems.length === 0 &&
			documents.every(
				(document) =>
					document.status === 'created' || document.status === 'identical',
			),
	};
}
