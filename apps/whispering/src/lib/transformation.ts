/**
 * One transformation request to an OpenAI-compatible endpoint.
 *
 * A transformation sends its prompt as the system message and the transcript
 * as the user message to `POST <base>/chat/completions`, and reads
 * `choices[0].message.content`. Plain `fetch` and nothing else, so the page
 * (browser folder) and the Bun folder host (desktop) run the same request. The
 * desktop host makes the call so the key stays out of the page and the
 * endpoint needs no CORS headers.
 *
 * The key never appears in an error: an endpoint that echoes it in a refusal
 * has it removed before the detail is returned.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const TransformationError = defineErrors({
	NotConfigured: ({ missing }: { missing: string }) => ({
		message: `This transformation cannot run: ${missing} is missing`,
		missing,
	}),
	HostUnavailable: ({ reason }: { reason: string }) => ({
		message: `The folder host could not be reached, so nothing was sent: ${reason}`,
		reason,
	}),
	Unreachable: ({ url, reason }: { url: string; reason: string }) => ({
		message: `The endpoint at ${url} could not be reached: ${reason}`,
		url,
		reason,
	}),
	Rejected: ({
		url,
		status,
		detail,
	}: {
		url: string;
		status: number;
		detail: string;
	}) => ({
		message: `The endpoint answered ${status}${detail ? `: ${detail}` : ''}`,
		url,
		status,
		detail,
	}),
	Malformed: ({ url }: { url: string }) => ({
		message: `The endpoint at ${url} did not answer with a chat completion`,
		url,
	}),
	Empty: ({ url }: { url: string }) => ({
		message: `The endpoint at ${url} answered with no text`,
		url,
	}),
});
export type TransformationError = InferErrors<typeof TransformationError>;

export type TransformationRequest = {
	readonly baseUrl: string;
	readonly model: string;
	/** Sent as a bearer credential when nonempty. A local endpoint may need none. */
	readonly apiKey: string;
	/** The system message. */
	readonly prompt: string;
	/** The user message: the transcript text, unchanged. */
	readonly input: string;
	readonly signal?: AbortSignal;
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export function chatCompletionsUrl(baseUrl: string): string {
	return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
}

/** The text of the first choice, or undefined when the answer has another shape. */
function firstChoiceText(parsed: unknown): string | undefined {
	if (typeof parsed !== 'object' || parsed === null || !('choices' in parsed))
		return undefined;
	const { choices } = parsed;
	if (!Array.isArray(choices)) return undefined;
	const first: unknown = choices[0];
	if (typeof first !== 'object' || first === null || !('message' in first))
		return undefined;
	const { message } = first;
	if (typeof message !== 'object' || message === null || !('content' in message))
		return undefined;
	return typeof message.content === 'string' ? message.content : undefined;
}

export async function requestTransformation({
	baseUrl,
	model,
	apiKey,
	prompt,
	input,
	signal,
	fetch: send = (url, init) => fetch(url, init),
}: TransformationRequest): Promise<
	Result<{ text: string }, TransformationError>
> {
	if (baseUrl.trim() === '')
		return TransformationError.NotConfigured({ missing: 'the endpoint URL' });
	if (model.trim() === '')
		return TransformationError.NotConfigured({ missing: 'the model' });
	if (prompt.trim() === '')
		return TransformationError.NotConfigured({ missing: 'the prompt' });
	if (input.trim() === '')
		return TransformationError.NotConfigured({ missing: 'the transcript text' });
	const url = chatCompletionsUrl(baseUrl);
	const redact = (text: string) =>
		apiKey === '' ? text : text.split(apiKey).join('[key removed]');

	let response: Response;
	try {
		response = await send(url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(apiKey !== '' && { authorization: `Bearer ${apiKey}` }),
			},
			body: JSON.stringify({
				model: model.trim(),
				messages: [
					{ role: 'system', content: prompt },
					{ role: 'user', content: input },
				],
			}),
			signal,
		});
	} catch (cause) {
		return TransformationError.Unreachable({
			url,
			reason: redact(describe(cause)),
		});
	}
	const body = await response.text().catch(() => '');
	if (!response.ok)
		return TransformationError.Rejected({
			url,
			status: response.status,
			detail: redact(body).slice(0, 300).trim(),
		});
	let text: string | undefined;
	try {
		text = firstChoiceText(JSON.parse(body));
	} catch {
		// Reported below: an answer that is not the expected JSON is malformed.
	}
	if (text === undefined) return TransformationError.Malformed({ url });
	if (text.trim() === '') return TransformationError.Empty({ url });
	return Ok({ text });
}
