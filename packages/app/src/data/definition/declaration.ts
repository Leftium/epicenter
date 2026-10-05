/**
 * What an App store declares: the shared declaration vocabulary, with a
 * table's body bound to a Yjs node.
 *
 * Fields, the declared mark, and the row lenses come from
 * `@epicenter/definition`, which every storage shares. The body codec is the
 * one part that names Yjs, so it stays here with the stores that keep live
 * bodies.
 */

import type {
	DataDefinition as SharedDataDefinition,
	DeclaredTable as SharedDeclaredTable,
	TableDeclaration as SharedTableDeclaration,
} from '@epicenter/definition';
import type * as Y from '@y/y';
import type { DeltaAny } from 'lib0/delta';

export {
	type CreateRowOf,
	type DeclaredMark,
	type FieldMap,
	field,
	KV_ROOT,
	type KvOf,
	RESERVED_TABLE_NAMES,
	type RowOf,
} from '@epicenter/definition';

/**
 * One table's file format for its body's complete sequence.
 *
 * The codec turns the live body into file text and parses file text into
 * insertion-only content. The artifact importer validates the content and
 * creates a fresh node for each row.
 * Nested rich-text nodes may carry their own attributes. A table without a
 * codec can export only an empty body and import only empty body text.
 */
export type BodyCodec = {
	readonly encode: (node: Y.Node) => string;
	readonly decode: (text: string) => DeltaAny;
};

/** Value-field schemas and the optional codec for the row's separately edited body. */
export type TableDeclaration = SharedTableDeclaration<BodyCodec>;

/** A table declaration that went through `defineTable`. */
export type DeclaredTable = SharedDeclaredTable<BodyCodec>;

/** One durable data domain's complete, inert definition. */
export type DataDefinition = SharedDataDefinition<BodyCodec>;
