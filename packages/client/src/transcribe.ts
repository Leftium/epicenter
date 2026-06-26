/**
 * `transcribe`: the one OpenAI-compatible speech-to-text client (ADR-0050/0056/0060).
 *
 * Transcription is a service: it holds nothing and sees only the audio blob you
 * hand it. So there is one wire (`POST {baseURL}/audio/transcriptions`, multipart
 * `file`, where the connection's `baseURL` already carries `/v1`) reached through
 * the same {@link ResolvedConnection} transport that drives chat, and zero
 * per-provider adapters. OpenAI, Groq, and a self-hosted Speaches box are not three
 * code paths; they are three connections, each `resolveConnection`d to a transport
 * and handed to the same function.
 *
 * Like `listModels` and the chat engine, this consumes the *resolved* transport
 * (`{ fetch, baseURL }`), not the static `Connection`.
 * `resolveConnection` is the single boundary that turns connection data into a
 * transport, and the caller crosses it: a third-party connection resolves its own
 * key into a Bearer, and the hosted Epicenter path injects its audience-scoped
 * session fetch (ADR-0053/0060), which is never connection data. So this client
 * never re-resolves and never branches on what kind of transport it got.
 *
 * Deepgram and ElevenLabs stay bespoke in their own clients: they do not speak
 * this wire (Deepgram takes a raw body under `Authorization: Token`, ElevenLabs an
 * `xi-api-key` with `model_id`), and ADR-0060 blesses that exception. Whispering's
 * in-process `transcribe-rs` engine also stays its own path: it is `invoke` over
 * the Tauri FFI, a privileged non-wire sibling, not a `Connection`.
 *
 * This is `apps/whispering/.../self-hosted/speaches.ts` generalized: the name
 * dropped and the bespoke config replaced by a transport. The error stays lean
 * and structured (it carries the HTTP `status`); an app maps a status to its own
 * user-facing copy at its toast/query layer, the library does not own that copy.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import type { ResolvedConnection } from './connection.js';

/**
 * The transcription request, minus the audio and the connection. `model` is
 * required because the wire never defaults it; `language` (an ISO-639-1 hint) and
 * `prompt` (a vocabulary/style hint) are optional, omitted from the form when
 * absent so a server's own defaults apply.
 */
export type TranscribeOptions = {
	model: string;
	language?: string;
	prompt?: string;
};

export const TranscribeError = defineErrors({
	/** The transport itself failed: network down, DNS, aborted, CORS, an FFI throw. */
	TransportFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not reach the transcription endpoint: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * The request reached a server but returned a non-2xx status. `status` and
	 * `detail` are carried so a consumer can branch (401 -> bad key, 413 -> too
	 * large) and surface its own copy.
	 */
	RequestFailed: ({ status, detail }: { status: number; detail?: string }) => ({
		message: `Transcription failed (${status})${detail ? `: ${detail}` : ''}`,
		status,
		detail,
	}),
	/** A 2xx body that was not the OpenAI `{ text: string }` shape. */
	Malformed: () => ({
		message: 'The transcription response was not an OpenAI { text } body.',
	}),
});
export type TranscribeError = InferErrors<typeof TranscribeError>;

/**
 * Transcribe an audio blob over the OpenAI wire. Takes the resolved transport
 * (`{ fetch, baseURL }`, see {@link ResolvedConnection}), POSTs a multipart form,
 * and returns the trimmed transcript text or a typed {@link TranscribeError}.
 * Never throws.
 *
 * The blob is sent under a filename whose extension is derived from its MIME type,
 * because the wire detects the audio format from that extension; see
 * {@link filenameForAudio}.
 */
export async function transcribe(
	audio: Blob,
	{ fetch, baseURL }: ResolvedConnection,
	{ model, language, prompt }: TranscribeOptions,
): Promise<Result<string, TranscribeError>> {
	const form = new FormData();
	form.append(
		'file',
		new File([audio], filenameForAudio(audio), {
			type: audio.type || 'audio/wav',
		}),
	);
	form.append('model', model);
	if (language) form.append('language', language);
	if (prompt) form.append('prompt', prompt);

	const { data: response, error: transportError } = await tryAsync({
		try: () =>
			fetch(`${baseURL.replace(/\/+$/, '')}/audio/transcriptions`, {
				method: 'POST',
				body: form,
			}),
		catch: (cause) => TranscribeError.TransportFailed({ cause }),
	});
	if (transportError) return Err(transportError);

	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		return TranscribeError.RequestFailed({ status: response.status, detail });
	}

	const { data: body, error: parseError } = await tryAsync({
		try: () => response.json() as Promise<unknown>,
		catch: () => TranscribeError.Malformed(),
	});
	if (parseError) return Err(parseError);

	const text = extractText(body);
	if (text === null) return TranscribeError.Malformed();
	return Ok(text.trim());
}

/**
 * Derive an upload filename from a blob's MIME type. The OpenAI wire reads the
 * audio format from the filename extension, so recorder output (`audio/webm`,
 * `audio/mp4`, `audio/ogg`, a Tauri `audio/wav`) becomes an accepted extension by
 * taking the subtype and dropping any `x-` prefix or `;codecs=...` parameter.
 * `mp3` is the fallback for a missing or odd type, the format every STT wire can
 * auto-detect from the bytes.
 */
function filenameForAudio(audio: Blob): string {
	const subtype = audio.type
		.split(';')[0]
		?.split('/')[1]
		?.replace(/^x-/, '');
	const extension = subtype && /^[a-z0-9]+$/.test(subtype) ? subtype : 'mp3';
	return `audio.${extension}`;
}

/** Pull `text` out of an OpenAI `{ text: string }` body, or null if the shape is wrong. */
function extractText(body: unknown): string | null {
	if (
		typeof body === 'object' &&
		body !== null &&
		'text' in body &&
		typeof (body as { text: unknown }).text === 'string'
	)
		return (body as { text: string }).text;
	return null;
}
