/**
 * Human text over the flat projections: {@link Violation}[] grouped by where it happened, plus a
 * {@link Summary} roll-up line. The text edge that mirrors the `--json` edge; both read the same
 * selectors, so the printed report and the serialized one carry the same facts.
 *
 * `formatExpected` is the second half of the expected-as-render-projection seam: `describeExpected`
 * (in `./expected`) turns a field into a serializable {@link ExpectedValue}, and this turns that
 * value into the phrase a user reads ("expected one of a, b"). An `invalid-type` violation carries
 * its field, so the phrase is computed HERE at render time, never stored upstream.
 */

import { describeExpected, type ExpectedValue } from './expected';
import type { Summary, Violation } from './violations';

function plural(count: number, word: string, pluralWord = `${word}s`): string {
	return `${count} ${count === 1 ? word : pluralWord}`;
}

function valuesText(values: readonly unknown[]): string {
	return values.map((value) => String(value)).join(', ');
}

/** A short, quoted preview of a raw value, truncated so one bad blob cannot flood the report. */
function previewValue(value: unknown): string {
	const text =
		typeof value === 'string'
			? JSON.stringify(value)
			: (JSON.stringify(value) ?? String(value));
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Turn the serializable {@link ExpectedValue} into the phrase a user reads. */
export function formatExpected(expected: ExpectedValue): string {
	switch (expected.kind) {
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
			return `one of ${valuesText(expected.values)}`;
		case 'tags':
			return 'array of strings';
		case 'multiSelect':
			return `array containing one of ${valuesText(expected.values)}`;
		case 'json':
			return 'JSON matching the field schema';
		case 'reference':
			return 'reference';
		default:
			return expected satisfies never;
	}
}

/** The one-line body of a row-scoped violation (table-scoped ones print under their table). */
function violationLine(violation: Violation): string {
	switch (violation.kind) {
		case 'missing-required':
			return `  ${violation.field}  needs value`;
		case 'invalid-type':
			return `  ${violation.field.name}  invalid: got ${previewValue(violation.raw)}, expected ${formatExpected(describeExpected(violation.field))}`;
		case 'dangling-reference':
			return `  ${violation.field}  dangling: "${violation.value}" not found in ${violation.target}`;
		case 'missing-target':
			return `  ${violation.field}  references ${violation.target}: no such table in the vault`;
	}
}

/** The row a violation belongs to for grouping; table-scoped `missing-target` has no row. */
function locationOf(violation: Violation): string {
	if (violation.kind === 'missing-target') return violation.table;
	return `${violation.table}/${violation.row}`;
}

/** Group violations under their location, preserving first-seen order. */
function groupByLocation(
	violations: readonly Violation[],
): Array<[string, Violation[]]> {
	const groups = new Map<string, Violation[]>();
	for (const violation of violations) {
		const key = locationOf(violation);
		const lines = groups.get(key) ?? [];
		lines.push(violation);
		groups.set(key, lines);
	}
	return [...groups.entries()];
}

/** The closing roll-up line: ready / attention, plus failures and untyped notes. */
function summaryLine(summary: Summary): string {
	const {
		tables,
		rows,
		ready,
		needsAttention,
		unreadable,
		invalidContract,
		unmodeled,
	} = summary.totals;

	const parts = [`${ready} ready`];
	if (needsAttention > 0) {
		parts.push(
			`${needsAttention} ${needsAttention === 1 ? 'needs' : 'need'} attention`,
		);
	}
	if (unreadable > 0)
		parts.push(plural(unreadable, 'unreadable', 'unreadable'));
	if (invalidContract > 0) parts.push(`${invalidContract} invalid contract`);
	if (unmodeled > 0) parts.push(`${unmodeled} untyped`);

	return `${parts.join(', ')} (${plural(tables, 'table')}, ${plural(rows, 'row')})`;
}

/**
 * The full human report: each location's violations, the extras as notes, and the summary line.
 * Pure over the two selectors, so it is the same answer the panel and `--json` give, in prose.
 */
export function formatReport(
	violations: readonly Violation[],
	summary: Summary,
): string {
	const sections = groupByLocation(violations).map(([location, group]) =>
		[location, ...group.map(violationLine)].join('\n'),
	);

	for (const extra of summary.extras) {
		sections.push(
			`${extra.table}/${extra.row}\n  note: extra keys ${extra.keys.join(', ')}`,
		);
	}

	sections.push(summaryLine(summary));
	return sections.join('\n\n');
}
