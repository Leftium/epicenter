/** A folder reads its tables and KV through the declaration's own lenses. */
import { expectTypeOf } from 'bun:test';
import {
	type CreateRowOf,
	defineStore,
	defineTable,
	field,
	type KvOf,
} from '../index.js';
import { InstantString } from '../data/field/index.js';
import type { FileKv, FileTable, Folder, KvSnapshot } from './index.js';

const definition = defineStore({
	id: 'test.folder',
	kv: { theme: field.string() },
	tables: {
		todos: defineTable({
			fields: {
				title: field.string(),
				due: field.nullable(field.instant()),
			},
		}),
	},
});
type Opened = Folder<typeof definition>;

expectTypeOf<Opened['tables']['todos']>().toEqualTypeOf<
	FileTable<CreateRowOf<typeof definition.tables.todos>>
>();
expectTypeOf<Opened['kv']>().toEqualTypeOf<FileKv<KvOf<typeof definition>>>();
expectTypeOf<
	CreateRowOf<typeof definition.tables.todos>['due']
>().toEqualTypeOf<InstantString | null>();

function typedValues(
	folder: Opened,
	snapshot: KvSnapshot<KvOf<typeof definition>>,
) {
	folder.tables.todos.create({ fields: { title: 'Milk', due: null } });
	folder.tables.todos.create({
		fields: { title: 'Milk', due: InstantString.now() },
	});
	folder.tables.todos.create({
		// @ts-expect-error An unvalidated string does not carry the instant brand.
		fields: { title: 'Milk', due: '2026-10-01T00:00:00.000Z' },
	});
	// @ts-expect-error Typed fields retain validation.
	folder.tables.todos.create({ fields: { title: 12, due: null } });
	// @ts-expect-error Creating a row supplies every declared field.
	folder.tables.todos.create({ fields: { title: 'Milk' } });
	// @ts-expect-error Only declared tables exist.
	folder.tables.lists;
	folder.kv.update(snapshot, { theme: 'dark' });
	// @ts-expect-error Only declared settings exist.
	folder.kv.update(snapshot, { language: 'en' });
}
void typedValues;
