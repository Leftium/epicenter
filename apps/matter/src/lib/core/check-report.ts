import type { Field, Kind } from '@epicenter/field';
import type { Cell } from './conformance';
import type { FolderRead } from './folder';

export type CheckReport = {
	version: 1;
	folder: string;
	model: {
		fields: Array<{ name: string; kind: Kind; required: boolean }>;
	};
	summary: {
		files: number;
		ready: number;
		needsAttention: number;
		unreadable: number;
	};
	findings: Array<
		| {
				file: string;
				field: string;
				state: 'NEEDS_VALUE';
		  }
		| {
				file: string;
				field: string;
				state: 'INVALID';
				actual: unknown;
				expected: string;
		  }
	>;
	byField: Array<{
		field: string;
		ok: number;
		empty: number;
		needsValue: number;
		invalid: number;
	}>;
	unreadable: Array<{
		file: string;
		error: string;
	}>;
	extras: Array<{
		file: string;
		keys: string[];
	}>;
};

export type FatalCheckReport = {
	version: 1;
	folder: string;
	fatal: {
		code:
			| 'FOLDER_UNREADABLE'
			| 'MODEL_MISSING'
			| 'MODEL_INVALID'
			| 'MODEL_UNRECOGNIZED_FIELD';
		message: string;
		fields?: string[];
	};
};

export type CheckResult = CheckReport | FatalCheckReport;

function valuesText(values: readonly unknown[]): string {
	return values.map((value) => String(value)).join(', ');
}

function describeExpected(field: Field): string {
	switch (field.kind) {
		case 'string':
			return 'string';
		case 'url':
			return 'url';
		case 'date':
			return 'date';
		case 'instant':
			return 'UTC instant';
		case 'datetime':
			return 'date-time string';
		case 'integer':
			return 'integer';
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'select':
			return `one of ${valuesText(field.schema.enum)}`;
		case 'tags':
			return 'array of strings';
		case 'multiSelect':
			return `array containing one of ${valuesText(field.schema.items.enum)}`;
		case 'json':
			return 'JSON matching the field schema';
		default:
			return field satisfies never;
	}
}

export function buildFatalCheckReport(
	folder: string,
	code: FatalCheckReport['fatal']['code'],
	message: string,
	fields?: string[],
): FatalCheckReport {
	return {
		version: 1,
		folder,
		fatal: fields ? { code, message, fields } : { code, message },
	};
}

function quotedList(values: readonly string[]): string {
	return values.map((value) => `"${value}"`).join(', ');
}

function unrecognizedFieldText(fields: readonly string[]): string {
	if (fields.length === 1) {
		return `field "${fields[0]!}" is not a recognized Matter field`;
	}

	return `fields ${quotedList(fields)} are not recognized Matter fields`;
}

function unmatchedOptionalText(fields: readonly string[]): string {
	if (fields.length === 1) {
		return `optional entry "${fields[0]!}" does not name a typed field`;
	}

	return `optional entries ${quotedList(fields)} do not name typed fields`;
}

function unrecognizedModelReport(
	folder: string,
	unmodeled: readonly string[],
	unmatchedOptional: readonly string[],
): FatalCheckReport {
	const fields = unique([...unmodeled, ...unmatchedOptional]);
	const parts = [
		unmodeled.length > 0 ? unrecognizedFieldText(unmodeled) : undefined,
		unmatchedOptional.length > 0
			? unmatchedOptionalText(unmatchedOptional)
			: undefined,
	].filter((part): part is string => part !== undefined);

	return buildFatalCheckReport(
		folder,
		'MODEL_UNRECOGNIZED_FIELD',
		parts.join('; '),
		fields,
	);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function increment(
	count: CheckReport['byField'][number],
	state: Cell['state'],
): void {
	switch (state) {
		case 'OK':
			count.ok += 1;
			return;
		case 'MISSING_OPTIONAL':
			count.empty += 1;
			return;
		case 'MISSING_REQUIRED':
			count.needsValue += 1;
			return;
		case 'INVALID':
			count.invalid += 1;
			return;
		default:
			state satisfies never;
	}
}

export function buildCheckResult(folder: string, read: FolderRead): CheckResult {
	if (read.view.mode === 'unmodeled') {
		if (read.view.modelError) {
			return buildFatalCheckReport(
				folder,
				'MODEL_INVALID',
				read.view.modelError.message,
			);
		}
		return buildFatalCheckReport(
			folder,
			'MODEL_INVALID',
			'matter.json did not produce a modeled view',
		);
	}

	if (
		read.view.model.unmodeled.length > 0 ||
		read.view.model.unmatchedOptional.length > 0
	) {
		return unrecognizedModelReport(
			folder,
			read.view.model.unmodeled,
			read.view.model.unmatchedOptional,
		);
	}

	const byField = read.view.model.fields.map((field) => ({
		field: field.name,
		ok: 0,
		empty: 0,
		needsValue: 0,
		invalid: 0,
	}));
	const countByField = new Map(byField.map((count) => [count.field, count]));
	const findings: CheckReport['findings'] = [];

	for (const conformance of read.view.conformance) {
		for (const cell of conformance.cells) {
			const count = countByField.get(cell.field.name);
			if (count) increment(count, cell.state);

			if (cell.state === 'MISSING_REQUIRED') {
				findings.push({
					file: conformance.row.fileName,
					field: cell.field.name,
					state: 'NEEDS_VALUE',
				});
			} else if (cell.state === 'INVALID') {
				findings.push({
					file: conformance.row.fileName,
					field: cell.field.name,
					state: 'INVALID',
					actual: cell.raw,
					expected: describeExpected(cell.field),
				});
			}
		}
	}

	const unreadable = read.unreadable.map((file) => ({
		file: file.fileName,
		error: file.error.message,
	}));
	const extras = read.view.conformance
		.filter((conformance) => conformance.extras.length > 0)
		.map((conformance) => ({
			file: conformance.row.fileName,
			keys: conformance.extras.map((extra) => extra.key),
		}));
	const ready = read.view.conformance.filter(
		(conformance) => conformance.rowValid,
	).length;
	const needsAttention = read.view.conformance.length - ready;

	return {
		version: 1,
		folder,
		model: {
			fields: read.view.model.fields.map((field) => ({
				name: field.name,
				kind: field.kind,
				required: field.required,
			})),
		},
		summary: {
			files: read.rows.length + read.unreadable.length,
			ready,
			needsAttention,
			unreadable: read.unreadable.length,
		},
		findings,
		byField,
		unreadable,
		extras,
	};
}

export function isFatalCheckReport(
	report: CheckResult,
): report is FatalCheckReport {
	return 'fatal' in report;
}
