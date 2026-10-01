/** The shared declaration compiler, typed for App's Yjs body codec. */
import {
	compileData as compileSharedData,
	type ParsedDataDefinition as SharedParsedDataDefinition,
	type ParsedTable as SharedParsedTable,
} from '@epicenter/definition';
import type { BodyCodec } from './declaration.js';

export {
	type Conformance,
	type ConformanceIssue,
	DataDefinitionParseError,
} from '@epicenter/definition';

export type ParsedTable = SharedParsedTable<BodyCodec>;
export type ParsedDataDefinition = SharedParsedDataDefinition<BodyCodec>;

/** Parse and compile one store definition, memoized beside the definition object. */
export const compileData = compileSharedData<BodyCodec>;
