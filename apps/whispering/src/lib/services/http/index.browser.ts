import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Err, tryAsync } from 'wellcrafted/result';
import type { HttpService } from './types';
import { HttpError } from './types';

export type {
	ConnectionError,
	HttpService,
	ParseError,
	ResponseError,
} from './types';
export { HttpError } from './types';

/**
 * Custom `fetch` function implementation for SDK clients (OpenAI, Anthropic).
 * Web builds expose `undefined`, so SDKs fall back to the global `fetch`.
 * The Tauri build (`index.tauri.ts`) exposes Tauri's HTTP plugin fetch to
 * bypass CORS.
 */
export const customFetch: typeof fetch | undefined = undefined;

export const HttpServiceLive = {
	async post({ body, url, schema, headers }) {
		const { data: response, error: responseError } = await tryAsync({
			try: () =>
				window.fetch(url, {
					method: 'POST',
					body,
					headers,
				}),
			catch: (error) =>
				HttpError.Connection({
					cause: error,
				}),
		});
		if (responseError) return Err(responseError);

		if (!response.ok) {
			return HttpError.Response({
				response,
				body: await response.json(),
			});
		}

		const parseResult = await tryAsync({
			try: async () => {
				const json = await response.json();
				const result = await schema['~standard'].validate(json);
				if (result.issues) {
					throw new Error(
						result.issues.map((issue) => issue.message).join(', '),
					);
				}
				return result.value as StandardSchemaV1.InferOutput<typeof schema>;
			},
			catch: (error) =>
				HttpError.Parse({
					cause: error,
				}),
		});
		return parseResult;
	},
} satisfies HttpService;
