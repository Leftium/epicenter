import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const ExtensionError = defineErrors({
	Table: ({
		tableName,
		rowId,
		operation,
	}: {
		tableName: string;
		rowId: string;
		operation: string;
	}) => ({
		message: `Extension table operation '${operation}' failed on '${tableName}' (row: ${rowId})`,
		tableName,
		rowId,
		operation,
	}),
	File: ({
		filename,
		filePath,
		operation,
	}: {
		filename: string;
		filePath: string;
		operation: string;
	}) => ({
		message: `Extension file operation '${operation}' failed: ${filename} at ${filePath}`,
		filename,
		filePath,
		operation,
	}),
	Directory: ({
		directory,
		operation,
	}: {
		directory: string;
		operation: string;
	}) => ({
		message: `Extension directory operation '${operation}' failed: ${directory}`,
		directory,
		operation,
	}),
});
export type ExtensionError = InferErrors<typeof ExtensionError>;
