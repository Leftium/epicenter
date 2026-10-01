/**
 * The application every bundle test builds. It imports the bare package and
 * nothing else, as ordinary application code does. Which adapter a build
 * carries is decided by the build's alias, never by this file.
 */
import {
	defineFolder,
	defineTable,
	field,
	openFolder,
} from '@epicenter/folder';

const definition = defineFolder({
	id: 'so.epicenter.bundlefixture',
	kv: {},
	tables: { notes: defineTable({ fields: { title: field.string() } }) },
});

export async function start() {
	const opened = await openFolder({ definition });
	if (opened.error) return opened.error.name;
	const terminal = opened.data.terminal();
	await terminal.exec('ls');
	return opened.data.location.kind;
}
