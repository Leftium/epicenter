/** The shared table door, typed for a body that is a Yjs node. */
import {
	type DefineTable,
	defineTable as defineSharedTable,
} from '@epicenter/definition';
import type { BodyCodec } from './declaration.js';

/** Declare value fields and, optionally, how the row's body becomes file text. */
export const defineTable: DefineTable<BodyCodec> = defineSharedTable;
