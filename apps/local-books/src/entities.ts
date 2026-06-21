/**
 * The QuickBooks entity registry: which QB types we mirror, the SQLite table
 * each lands in, and the handful of scalar columns worth lifting out of the raw
 * blob for indexing and joins. Everything else stays in `raw`, so a new QB
 * field needs no migration.
 *
 * The raw blob is canonical; extracted columns are a denormalized convenience.
 * On a CDC delete we only get a stub (Id + MetaData), so extractors must return
 * `null` for absent fields rather than throw.
 */

export type ColumnType = 'TEXT' | 'INTEGER' | 'REAL';
export type ColumnValue = string | number | null;

export type ExtractedColumn = {
	name: string;
	type: ColumnType;
	extract: (raw: QbObject) => ColumnValue;
};

export type EntityDef = {
	/** QuickBooks entity name, e.g. `Invoice` (also the CDC `entities` value). */
	name: string;
	/** SQLite table name, e.g. `invoices`. */
	table: string;
	columns: ExtractedColumn[];
};

export type QbObject = Record<string, unknown> & {
	Id?: string | number;
	status?: string;
	MetaData?: { LastUpdatedTime?: string; CreateTime?: string };
};

function path(raw: QbObject, ...keys: string[]): unknown {
	let value: unknown = raw;
	for (const key of keys) {
		if (value === null || typeof value !== 'object') return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

function text(...keys: string[]): (raw: QbObject) => ColumnValue {
	return (raw) => {
		const value = path(raw, ...keys);
		return typeof value === 'string' || typeof value === 'number'
			? String(value)
			: null;
	};
}

function real(...keys: string[]): (raw: QbObject) => ColumnValue {
	return (raw) => {
		const value = path(raw, ...keys);
		const num = typeof value === 'number' ? value : Number(value);
		return Number.isFinite(num) ? num : null;
	};
}

function bool(...keys: string[]): (raw: QbObject) => ColumnValue {
	return (raw) => {
		const value = path(raw, ...keys);
		if (value === true) return 1;
		if (value === false) return 0;
		return null;
	};
}

function col(
	name: string,
	type: ColumnType,
	extract: (raw: QbObject) => ColumnValue,
): ExtractedColumn {
	return { name, type, extract };
}

/**
 * Default mirror set. Each is a CDC-supported QuickBooks transaction or
 * name-list entity. Extend or trim via `config.json` `entities`.
 */
export const ENTITY_DEFS: Record<string, EntityDef> = {
	Invoice: {
		name: 'Invoice',
		table: 'invoices',
		columns: [
			col('doc_number', 'TEXT', text('DocNumber')),
			col('doc_date', 'TEXT', text('TxnDate')),
			col('total_amt', 'REAL', real('TotalAmt')),
			col('balance', 'REAL', real('Balance')),
			col('customer_ref', 'TEXT', text('CustomerRef', 'value')),
		],
	},
	Customer: {
		name: 'Customer',
		table: 'customers',
		columns: [
			col('display_name', 'TEXT', text('DisplayName')),
			col('company_name', 'TEXT', text('CompanyName')),
			col('email', 'TEXT', text('PrimaryEmailAddr', 'Address')),
			col('active', 'INTEGER', bool('Active')),
			col('balance', 'REAL', real('Balance')),
		],
	},
	Item: {
		name: 'Item',
		table: 'items',
		columns: [
			col('name', 'TEXT', text('Name')),
			col('type', 'TEXT', text('Type')),
			col('unit_price', 'REAL', real('UnitPrice')),
			col('active', 'INTEGER', bool('Active')),
		],
	},
	Payment: {
		name: 'Payment',
		table: 'payments',
		columns: [
			col('txn_date', 'TEXT', text('TxnDate')),
			col('total_amt', 'REAL', real('TotalAmt')),
			col('customer_ref', 'TEXT', text('CustomerRef', 'value')),
		],
	},
	Bill: {
		name: 'Bill',
		table: 'bills',
		columns: [
			col('doc_number', 'TEXT', text('DocNumber')),
			col('txn_date', 'TEXT', text('TxnDate')),
			col('total_amt', 'REAL', real('TotalAmt')),
			col('balance', 'REAL', real('Balance')),
			col('vendor_ref', 'TEXT', text('VendorRef', 'value')),
		],
	},
	Vendor: {
		name: 'Vendor',
		table: 'vendors',
		columns: [
			col('display_name', 'TEXT', text('DisplayName')),
			col('company_name', 'TEXT', text('CompanyName')),
			col('active', 'INTEGER', bool('Active')),
			col('balance', 'REAL', real('Balance')),
		],
	},
	Account: {
		name: 'Account',
		table: 'accounts',
		columns: [
			col('name', 'TEXT', text('Name')),
			col('account_type', 'TEXT', text('AccountType')),
			col('current_balance', 'REAL', real('CurrentBalance')),
			col('active', 'INTEGER', bool('Active')),
		],
	},
};

/** The default entities mirrored when config does not narrow the set. */
export const DEFAULT_ENTITIES: string[] = Object.keys(ENTITY_DEFS);

export function isKnownEntity(name: string): boolean {
	return name in ENTITY_DEFS;
}

export function entityDef(name: string): EntityDef {
	const def = ENTITY_DEFS[name];
	if (!def) {
		throw new Error(
			`Unknown QuickBooks entity "${name}". Known entities: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
	}
	return def;
}

/** A deleted CDC record carries `status: "Deleted"`; everything else is live. */
export function isDeleted(raw: QbObject): boolean {
	return typeof raw.status === 'string' && raw.status.toLowerCase() === 'deleted';
}

export function lastUpdatedTime(raw: QbObject): string | null {
	const value = raw.MetaData?.LastUpdatedTime;
	return typeof value === 'string' ? value : null;
}
