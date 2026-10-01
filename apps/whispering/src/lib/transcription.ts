/**
 * One transcription request to an OpenAI-compatible endpoint.
 *
 * Plain `fetch` and nothing else, so the page (browser folder) and the Bun
 * folder host (desktop) run the same request. The desktop host makes the call
 * so the key stays out of the page and the endpoint needs no CORS headers.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const TranscriptionError = defineErrors({
	NotConfigured: ({ missing }: { missing: string }) => ({
		message: `Transcription is not set up: ${missing} is missing`,
		missing,
	}),
	HostUnavailable: ({ reason }: { reason: string }) => ({
		message: `The folder host could not be reached, so nothing was sent: ${reason}`,
		reason,
	}),
	AudioUnreadable: ({ path, reason }: { path: string; reason: string }) => ({
		message: `The audio at '${path}' could not be read: ${reason}`,
		path,
		reason,
	}),
	Unreachable: ({ url, reason }: { url: string; reason: string }) => ({
		message: `The transcription endpoint at ${url} could not be reached: ${reason}`,
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
		message: `The transcription endpoint answered ${status}${detail ? `: ${detail}` : ''}`,
		url,
		status,
		detail,
	}),
	Malformed: ({ url }: { url: string }) => ({
		message: `The transcription endpoint at ${url} did not answer with transcript text`,
		url,
	}),
});
export type TranscriptionError = InferErrors<typeof TranscriptionError>;

export type TranscriptionRequest = {
	readonly baseUrl: string;
	readonly model: string;
	/** Sent as a bearer credential when nonempty. A local endpoint may need none. */
	readonly apiKey: string;
	readonly audio: {
		readonly bytes: Uint8Array;
		readonly filename: string;
		readonly mimeType: string;
	};
	readonly signal?: AbortSignal;
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export function transcriptionUrl(baseUrl: string): string {
	return `${baseUrl.trim().replace(/\/+$/, '')}/audio/transcriptions`;
}

export async function requestTranscription({
	baseUrl,
	model,
	apiKey,
	audio,
	signal,
	fetch: send = (input, init) => fetch(input, init),
}: TranscriptionRequest): Promise<
	Result<{ text: string }, TranscriptionError>
> {
	if (baseUrl.trim() === '')
		return TranscriptionError.NotConfigured({ missing: 'the endpoint URL' });
	if (model.trim() === '')
		return TranscriptionError.NotConfigured({ missing: 'the model' });
	const url = transcriptionUrl(baseUrl);
	const form = new FormData();
	form.append(
		'file',
		new Blob([audio.bytes as Uint8Array<ArrayBuffer>], {
			type: audio.mimeType,
		}),
		audio.filename,
	);
	form.append('model', model.trim());
	form.append('response_format', 'json');

	let response: Response;
	try {
		response = await send(url, {
			method: 'POST',
			headers: apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
			body: form,
			signal,
		});
	} catch (cause) {
		return TranscriptionError.Unreachable({ url, reason: describe(cause) });
	}
	const body = await response.text().catch(() => '');
	if (!response.ok)
		return TranscriptionError.Rejected({
			url,
			status: response.status,
			detail: body.slice(0, 300).trim(),
		});
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			'text' in parsed &&
			typeof parsed.text === 'string'
		)
			return Ok({ text: parsed.text });
	} catch {
		// Reported below: an answer that is not the expected JSON is malformed.
	}
	return TranscriptionError.Malformed({ url });
}
