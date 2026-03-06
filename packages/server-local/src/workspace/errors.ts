import { defineErrors, extractErrorMessage, type InferErrors } from 'wellcrafted/error';

export const WorkspaceApiError = defineErrors({
	WorkspaceNotFound: () => ({
		message: 'Workspace not found',
	}),
	ActionsNotConfigured: () => ({
		message: 'Workspace or actions not found',
	}),
	ActionNotFound: ({ actionPath }: { actionPath: string }) => ({
		message: `Action not found: ${actionPath}`,
		actionPath,
	}),
	ActionWrongMethod: ({
		actionPath,
		expected,
	}: { actionPath: string; expected: 'GET' | 'POST' }) => ({
		message: `Action "${actionPath}" is a ${expected === 'GET' ? 'query, use GET' : 'mutation, use POST'}`,
		actionPath,
		expected,
	}),
	TableNotFound: () => ({
		message: 'Table not found',
	}),
	KvOperationFailed: ({ key, cause }: { key: string; cause: unknown }) => ({
		message: extractErrorMessage(cause),
		key,
		cause,
	}),
});
export type WorkspaceApiError = InferErrors<typeof WorkspaceApiError>;
