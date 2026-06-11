import type { CheckReport, CheckResult, FatalCheckReport } from './check-report';
import { isFatalCheckReport } from './check-report';

type FileLine =
	| { kind: 'finding'; finding: CheckReport['findings'][number] }
	| { kind: 'unreadable'; unreadable: CheckReport['unreadable'][number] }
	| { kind: 'extras'; extras: CheckReport['extras'][number] };

function plural(count: number, word: string, pluralWord = `${word}s`): string {
	return `${count} ${count === 1 ? word : pluralWord}`;
}

function lowerFirst(text: string): string {
	return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}

function firstLine(text: string): string {
	return text.split('\n')[0] ?? text;
}

function previewActual(value: unknown): string {
	const text =
		typeof value === 'string'
			? JSON.stringify(value)
			: JSON.stringify(value) ?? String(value);
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function fileGroups(report: CheckReport): Array<[string, FileLine[]]> {
	const groups = new Map<string, FileLine[]>();
	const push = (file: string, line: FileLine): void => {
		const lines = groups.get(file) ?? [];
		lines.push(line);
		groups.set(file, lines);
	};

	for (const finding of report.findings) {
		push(finding.file, { kind: 'finding', finding });
	}
	for (const unreadable of report.unreadable) {
		push(unreadable.file, { kind: 'unreadable', unreadable });
	}
	for (const extras of report.extras) {
		push(extras.file, { kind: 'extras', extras });
	}

	return [...groups.entries()];
}

function formatFinding(
	finding: CheckReport['findings'][number],
	fieldWidth: number,
): string {
	const field = finding.field.padEnd(fieldWidth);
	if (finding.state === 'NEEDS_VALUE') return `  ${field}  needs value`;
	return `  ${field}  invalid: got ${previewActual(finding.actual)}, expected ${finding.expected}`;
}

function formatFileLine(line: FileLine, fieldWidth: number): string {
	switch (line.kind) {
		case 'finding':
			return formatFinding(line.finding, fieldWidth);
		case 'unreadable':
			return `  can't read: ${lowerFirst(firstLine(line.unreadable.error))}`;
		case 'extras':
			return `  note: extra keys ${line.extras.keys.join(', ')}`;
		default:
			return line satisfies never;
	}
}

function formatByField(report: CheckReport, fieldWidth: number): string[] {
	const lines = report.byField
		.map((field) => {
			const parts = [
				field.needsValue > 0
					? `${field.needsValue} needs value`
					: undefined,
				field.invalid > 0 ? plural(field.invalid, 'invalid', 'invalid') : undefined,
			].filter((part): part is string => part !== undefined);
			if (parts.length === 0) return undefined;
			return `  ${field.field.padEnd(fieldWidth)}  ${parts.join(', ')}`;
		})
		.filter((line): line is string => line !== undefined);

	return lines.length === 0 ? [] : ['By field:', ...lines];
}

function formatSummary(report: CheckReport): string {
	const { files, needsAttention, ready, unreadable } = report.summary;
	if (needsAttention === 0 && unreadable === 0) {
		return `${ready} ready (${plural(files, 'file')})`;
	}

	const parts = [
		`${ready} ready`,
		`${needsAttention} ${needsAttention === 1 ? 'needs' : 'need'} attention`,
		unreadable > 0 ? plural(unreadable, 'unreadable', 'unreadable') : undefined,
	].filter((part): part is string => part !== undefined);
	return `${parts.join(', ')} (${plural(files, 'file')})`;
}

function formatFatalCheckReport(report: FatalCheckReport): string {
	return `cannot check ${report.folder}: ${report.fatal.message}`;
}

function formatCheckReport(report: CheckReport): string {
	const groups = fileGroups(report);
	const fieldWidth = Math.max(
		0,
		...report.model.fields.map((field) => field.name.length),
	);

	if (groups.length === 0) return formatSummary(report);

	const sections = groups.map(([file, lines]) =>
		[file, ...lines.map((line) => formatFileLine(line, fieldWidth))].join('\n'),
	);
	const byField = formatByField(report, fieldWidth);
	if (byField.length > 0) sections.push(byField.join('\n'));
	sections.push(formatSummary(report));
	return sections.join('\n\n');
}

export function formatCheckResult(report: CheckResult): string {
	if (isFatalCheckReport(report)) return formatFatalCheckReport(report);
	return formatCheckReport(report);
}
