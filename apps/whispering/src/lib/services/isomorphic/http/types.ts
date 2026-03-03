import type { StandardSchemaV1 } from '@standard-schema/spec';
import { defineErrors, extractErrorMessage, type InferError, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const HttpError = defineErrors({
	Connection: ({ cause }: { cause: unknown }) => ({
		message: `Failed to connect to the server: ${extractErrorMessage(cause)}`,
		cause,
	}),
	Response: ({ response, body }: {
		response: { status: number };
		/** The parsed response body from the HTTP error response. */
		body: unknown;
	}) => ({
		message: `HTTP ${response.status}: ${extractErrorMessage(body)}`,
		status: response.status,
		body,
	}),
	Parse: ({ cause }: { cause: unknown }) => ({
		message: `Failed to parse response body: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

export type HttpError = InferErrors<typeof HttpError>;
export type ConnectionError = InferError<typeof HttpError.Connection>;
export type ResponseError = InferError<typeof HttpError.Response>;
export type ParseError = InferError<typeof HttpError.Parse>;

export type HttpService = {
	/**
	 * Makes a POST request with automatic JSON parsing and schema validation.
	 *
	 * Accepts any schema that implements the StandardSchemaV1 interface (Zod, Valibot, ArkType, etc.)
	 *
	 * **Error Handling Strategy:**
	 * 1. **Connection Phase:** Catches network-level failures (ConnectionError)
	 * 2. **Response Phase:** Validates HTTP status codes (ResponseError)
	 * 3. **Parse Phase:** Validates JSON structure and schema (ParseError)
	 */
	post: <TSchema extends StandardSchemaV1>(config: {
		url: string;
		body: BodyInit | FormData;
		schema: TSchema;
		headers?: Record<string, string>;
	}) => Promise<
		Result<StandardSchemaV1.InferOutput<TSchema>, HttpError>
	>;
};
