import type { StandardSchemaV1 } from '@standard-schema/spec';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import type { HttpService } from '.';
import { ConnectionErr, ParseErr, ResponseErr } from './types';

export function createHttpServiceWeb(): HttpService {
	return {
		async post({ body, url, schema, headers }) {
			const { data: response, error: responseError } = await tryAsync({
				try: () =>
					window.fetch(url, {
						method: 'POST',
						body,
						headers,
					}),
				catch: (error) =>
					ConnectionErr({
						message: `Failed to establish connection: ${extractErrorMessage(error)}`,
					}),
			});
			if (responseError) return Err(responseError);

			if (!response.ok) {
				return ResponseErr({
					message: extractErrorMessage(await response.json()),
					context: { status: response.status },
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
					ParseErr({
						message: `Failed to parse response: ${extractErrorMessage(error)}`,
					}),
			});
			return parseResult;
		},
	};
}
