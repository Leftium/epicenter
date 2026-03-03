import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const ExtensionError = defineErrors({
	Operation: (input: {
		tableName?: string;
		rowId?: string;
		filename?: string;
		filePath?: string;
		directory?: string;
		operation?: string;
	}) => ({
		message: input.operation
			? `Extension operation '${input.operation}' failed`
			: 'An extension operation failed',
		...input,
	}),
});
export type ExtensionError = InferErrors<typeof ExtensionError>;
