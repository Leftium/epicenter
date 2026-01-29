import slugify from '@sindresorhus/slugify';
import type { $Type, IsPrimaryKey, NotNull } from 'drizzle-orm';
import {
	integer,
	real,
	type SQLiteBooleanBuilderInitial,
	type SQLiteCustomColumnBuilder,
	type SQLiteIntegerBuilderInitial,
	type SQLiteRealBuilderInitial,
	type SQLiteTable,
	type SQLiteTextBuilderInitial,
	sqliteTable,
	text,
} from 'drizzle-orm/sqlite-core';
import type { Static, TSchema } from 'typebox';
import { date, json, tags } from '../../../extensions/sqlite/builders';
import type { DateTimeString } from '../fields/datetime';
import { isNullableField } from '../fields/helpers';
import type {
	BooleanFieldSchema,
	DateFieldSchema,
	Field,
	FieldSchema,
	IdFieldSchema,
	IntegerFieldSchema,
	JsonFieldSchema,
	RealFieldSchema,
	RichtextFieldSchema,
	SelectFieldSchema,
	TableDefinitionMap,
	TagsFieldSchema,
	TextFieldSchema,
} from '../fields/types';

export function toSqlIdentifier(displayName: string): string {
	return slugify(displayName, { separator: '_' });
}

/**
 * Maps table definitions to their Drizzle table representations.
 *
 * Use this type when you need to reference the return type of
 * `convertTableDefinitionsToDrizzle` in your type definitions.
 */
export type TableDefinitionsToDrizzle<
	TTableDefinitionMap extends TableDefinitionMap,
> = {
	[K in keyof TTableDefinitionMap & string]: ReturnType<
		typeof convertTableToDrizzle<K, TTableDefinitionMap[K]['fields'][number]>
	>;
};

/**
 * Convert table definitions to Drizzle SQLite tables.
 *
 * This is the main entry point for converting a TableDefinitionMap
 * into Drizzle table definitions for database operations.
 *
 * @param definitions - The table definitions (from `tables.definitions`)
 * @returns A record mapping table names to their Drizzle SQLiteTable representations
 *
 * @example
 * ```typescript
 * // In an extension, use tables.definitions directly
 * const drizzleTables = convertTableDefinitionsToDrizzle(tables.definitions);
 *
 * // Use with Drizzle queries
 * const allUsers = await db.select().from(drizzleTables.users);
 * ```
 */
export function convertTableDefinitionsToDrizzle<
	TTableDefinitionMap extends TableDefinitionMap,
>(
	definitions: TTableDefinitionMap,
): TableDefinitionsToDrizzle<TTableDefinitionMap> {
	const result: Record<string, SQLiteTable> = {};

	for (const tableName of Object.keys(definitions)) {
		const tableDefinition = definitions[tableName];
		if (!tableDefinition) {
			throw new Error(`Table definition for "${tableName}" is undefined`);
		}
		result[tableName] = convertTableToDrizzle(
			tableName,
			tableDefinition.fields,
		);
	}

	return result as TableDefinitionsToDrizzle<TTableDefinitionMap>;
}

/** Convert a single table schema to a Drizzle SQLiteTable. */
function convertTableToDrizzle<
	TTableName extends string,
	TField extends Field,
>(tableName: TTableName, fields: readonly TField[]) {
	const columns = Object.fromEntries(
		fields.map((field) => {
			const sqlColumnName = field.name ? toSqlIdentifier(field.name) : field.id;
			return [field.id, convertFieldToDrizzle(sqlColumnName, field)];
		}),
	) as {
		[K in TField['id']]: FieldToDrizzle<Extract<TField, { id: K }>>;
	};

	return sqliteTable(tableName, columns);
}

type FieldToDrizzle<C extends FieldSchema> = C extends IdFieldSchema
	? IsPrimaryKey<
			NotNull<SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>>
		>
	: C extends TextFieldSchema<infer TNullable>
		? TNullable extends true
			? SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>
			: NotNull<SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>>
		: C extends RichtextFieldSchema
			? SQLiteTextBuilderInitial<'', [string, ...string[]], undefined>
			: C extends IntegerFieldSchema<infer TNullable>
				? TNullable extends true
					? SQLiteIntegerBuilderInitial<''>
					: NotNull<SQLiteIntegerBuilderInitial<''>>
				: C extends RealFieldSchema<infer TNullable>
					? TNullable extends true
						? SQLiteRealBuilderInitial<''>
						: NotNull<SQLiteRealBuilderInitial<''>>
					: C extends BooleanFieldSchema<infer TNullable>
						? TNullable extends true
							? SQLiteBooleanBuilderInitial<''>
							: NotNull<SQLiteBooleanBuilderInitial<''>>
						: C extends DateFieldSchema<infer TNullable>
							? TNullable extends true
								? $Type<
										SQLiteTextBuilderInitial<
											'',
											[string, ...string[]],
											undefined
										>,
										DateTimeString
									>
								: NotNull<
										$Type<
											SQLiteTextBuilderInitial<
												'',
												[string, ...string[]],
												undefined
											>,
											DateTimeString
										>
									>
							: C extends SelectFieldSchema<infer TOptions, infer TNullable>
								? TNullable extends true
									? SQLiteTextBuilderInitial<
											'',
											[...TOptions],
											number | undefined
										>
									: NotNull<
											SQLiteTextBuilderInitial<
												'',
												[...TOptions],
												number | undefined
											>
										>
								: C extends TagsFieldSchema<infer TOptions, infer TNullable>
									? TNullable extends true
										? SQLiteCustomColumnBuilder<{
												name: '';
												dataType: 'custom';
												columnType: 'SQLiteCustomColumn';
												data: TOptions[number][];
												driverParam: string;
												enumValues: undefined;
											}>
										: NotNull<
												SQLiteCustomColumnBuilder<{
													name: '';
													dataType: 'custom';
													columnType: 'SQLiteCustomColumn';
													data: TOptions[number][];
													driverParam: string;
													enumValues: undefined;
												}>
											>
									: C extends JsonFieldSchema<
												infer T extends TSchema,
												infer TNullable
											>
										? TNullable extends true
											? SQLiteCustomColumnBuilder<{
													name: '';
													dataType: 'custom';
													columnType: 'SQLiteCustomColumn';
													data: Static<T>;
													driverParam: string;
													enumValues: undefined;
												}>
											: NotNull<
													SQLiteCustomColumnBuilder<{
														name: '';
														dataType: 'custom';
														columnType: 'SQLiteCustomColumn';
														data: Static<T>;
														driverParam: string;
														enumValues: undefined;
													}>
												>
										: never;

function convertFieldToDrizzle<C extends FieldSchema>(
	columnName: string,
	field: C,
): FieldToDrizzle<C> {
	const isNullable = isNullableField(field);

	switch (field.type) {
		case 'id':
			return text(columnName).primaryKey().notNull() as FieldToDrizzle<C>;

		case 'text': {
			let column = text(columnName);
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'richtext': {
			let column = text(columnName);
			if (!isNullable) column = column.notNull();
			return column as FieldToDrizzle<C>;
		}

		case 'integer': {
			let column = integer(columnName);
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'real': {
			let column = real(columnName);
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'boolean': {
			let column = integer(columnName, { mode: 'boolean' });
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'date': {
			const column = date({
				nullable: isNullable,
				default: field.default,
			});
			return column as unknown as FieldToDrizzle<C>;
		}

		case 'select': {
			let column = text(columnName, { enum: [...field.options] });
			if (!isNullable) column = column.notNull();
			if (field.default !== undefined) {
				column = column.default(field.default);
			}
			return column as FieldToDrizzle<C>;
		}

		case 'tags': {
			const column = tags({
				options: field.options,
				nullable: isNullable,
				default: field.default,
			});
			return column as FieldToDrizzle<C>;
		}

		case 'json': {
			const column = json({
				schema: field.schema,
				nullable: isNullable,
				default: field.default,
			});
			return column as FieldToDrizzle<C>;
		}

		default:
			throw new Error(`Unknown field type: ${(field as FieldSchema).type}`);
	}
}
