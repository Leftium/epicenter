/**
 * Compile-time checks for reserved names, complete body codecs, value-only
 * rows, and inferred creation inputs. Runtime checks live in prepare.test.ts
 * and body-boundary.test.ts.
 */
import { defineStore } from '@epicenter/app';

import { plainText } from './body.js';
import type { CreateRowOf, RowOf } from './declaration.js';

import { defineTable, field } from './index.js';

defineTable({
	fields: {},
	// @ts-expect-error the body option accepts a codec, not a field schema
	body: field.string(),
});

const fieldsOnly = defineTable({
	fields: { name: field.string(), sql: field.string() },
});
declare const fieldsOnlyRow: RowOf<typeof fieldsOnly>;
const rowName: string = fieldsOnlyRow.name;
const rowSql: string = fieldsOnlyRow.sql;
// @ts-expect-error live bodies are not part of value snapshots
fieldsOnlyRow.body;
const newRow: CreateRowOf<typeof fieldsOnly> = {
	name: 'Inbox',
	sql: 'SELECT 1',
};
void [rowName, rowSql, newRow];
// @ts-expect-error omission does not widen the exact field keys
fieldsOnlyRow.unknown;
// @ts-expect-error SQL remains required
const incomplete: CreateRowOf<typeof fieldsOnly> = { name: 'Inbox' };
defineTable({ fields: {}, body: undefined });
defineTable({
	fields: {},
	// @ts-expect-error a supplied codec requires decode
	body: { encode: plainText().encode },
});
defineTable({
	fields: {
		// @ts-expect-error reserved keys also fail without a codec
		ID: field.string(),
	},
});

defineTable({
	fields: {
		// @ts-expect-error 'id' is reserved: every row already has one
		id: field.string(),
	},
	body: plainText(),
});

/**
 * A native `default` annotation is admitted, in a table and in kv.
 *
 * Nothing applies one: validation does not fill or change a value, so the
 * keyword is inert and the field still reads as its schema's type. The default
 * is spread in because no helper takes one as an option.
 */
const annotated = defineTable({
	fields: {
		title: { ...field.string(), default: 'untitled' },
	},
	body: plainText(),
});
// @ts-expect-error the annotation does not make the field optional
const withoutTitle: CreateRowOf<typeof annotated> = {};
void withoutTitle;

/**
 * A table has one door, and a bare literal is not it.
 *
 * `defineTable` brands its return and `DataDefinition` requires the brand, so a
 * structurally-correct literal handed straight to `defineStore` is refused. That
 * is what lets every table rule live on `defineTable`'s parameter alone: there
 * is no second authoring path left to re-check, which is what `ValidateTable`
 * and `ValidateDefinition` used to be for.
 *
 * It also fixed the message. On the old `defineStore` path the refusal was
 * carried through `TData & ValidateDefinition<TData>`, and the intersection
 * collapsed the offending element to `never`, taking the explanation with it.
 * A collision now reports the same sentence wherever it is written.
 */
defineStore({
	id: 'so.epicenter.bare-literal',
	kv: {},
	tables: {
		// @ts-expect-error a table is authored with `defineTable`
		notes: { title: field.string() },
	},
});

defineStore({
	id: 'so.epicenter.declaration-default',
	kv: {
		theme: { ...field.string(), default: 'light' },
	},
	tables: {
		items: defineTable({
			fields: {
				title: field.string(),
			},
			body: plainText(),
		}),
	},
});

// Body storage consumes no field name.
const ordinaryNames = defineTable({
	fields: {
		content: field.string(),
		'!status': field.string(),
		Body: field.string(),
		body: field.string(),
	},
});
const ordinaryInput: CreateRowOf<typeof ordinaryNames> = {
	content: 'value',
	'!status': 'draft',
	Body: 'capitalized',
	body: 'ordinary metadata',
};
void ordinaryInput;
declare const ordinaryRow: RowOf<typeof ordinaryNames>;
const bodyValue: string = ordinaryRow.body;
void bodyValue;
defineTable({
	fields: {
		body: field.string(),
	},
});
