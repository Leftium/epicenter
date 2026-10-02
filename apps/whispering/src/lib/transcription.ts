/**
 * One transcription request to an OpenAI-compatible endpoint.
 *
 * Plain `fetch` and nothing else, so the page (browser folder) and the Bun
 * host (desktop) run the same request. The desktop host makes the call so the
 * key stays out of the page and the endpoint needs no CORS headers.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const TranscriptionError = defineErrors({
	NotConfigured: ({ missing }: { missing: string }) => ({
		message: `Transcription is not set up: ${missing} is missing`,
		missing,
	}),
	/**
	 * The host did not answer, or its answer never arrived. That says nothing
	 * about what the host did: it may never have been reached, or it may have
	 * sent the request and had its answer lost on the way back. The outcome is
	 * unknown, and nothing is sent again without the person asking.
	 */
	HostUnavailable: ({ reason }: { reason: string }) => ({
		message: `Whispering’s host did not answer, so it is not known whether the request was sent or what came back: ${reason}. Nothing is sent again unless you try again.`,
		reason,
	}),
	/** The audio was not read, so no request was made. This one is certain. */
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

	// An endpoint that echoes the key in a refusal must not carry it to the page.
	const redact = (text: string) =>
		apiKey === '' ? text : text.split(apiKey).join('[key removed]');

	let response: Response;
	try {
		response = await send(url, {
			method: 'POST',
			headers: apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` },
			body: form,
			signal,
		});
	} catch (cause) {
		return TranscriptionError.Unreachable({
			url,
			reason: redact(describe(cause)),
		});
	}
	const body = await response.text().catch(() => '');
	if (!response.ok)
		return TranscriptionError.Rejected({
			url,
			status: response.status,
			detail: redact(body).slice(0, 300).trim(),
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
