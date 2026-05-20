import { MAX_PAYLOAD_BYTES } from './constants';

type RoomSyncBackend = {
	sync(
		roomName: string,
		body: Uint8Array,
	): Promise<{
		diff: Uint8Array | null;
		storageBytes: number;
	}>;
	getDoc(roomName: string): Promise<{ data: Uint8Array; storageBytes: number }>;
};

export function createSyncEngine(
	rooms: RoomSyncBackend,
	options?: {
		maxPayloadBytes?: number;
	},
) {
	const maxPayloadBytes = options?.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;

	return {
		async handleHttpSync(
			request: Request,
			input: {
				roomName: string;
			},
		): Promise<{
			response: Response;
			storageBytes: number | null;
		}> {
			const body = new Uint8Array(await request.arrayBuffer());
			if (body.byteLength > maxPayloadBytes) {
				return {
					response: new Response('Payload too large', { status: 413 }),
					storageBytes: null,
				};
			}

			const { diff, storageBytes } = await rooms.sync(input.roomName, body);

			return {
				response: diff
					? binaryResponse(diff)
					: new Response(null, { status: 204 }),
				storageBytes,
			};
		},

		async getSnapshot(roomName: string): Promise<{
			response: Response;
			storageBytes: number;
		}> {
			const { data, storageBytes } = await rooms.getDoc(roomName);
			return { response: binaryResponse(data), storageBytes };
		},
	};
}

/**
 * Wrap a Uint8Array in a Response with a fresh ArrayBuffer copy.
 *
 * Yjs encoders return Uint8Array views that may share a larger internal
 * backing buffer. The copy isolates exactly the bytes that should be sent.
 */
function binaryResponse(data: Uint8Array): Response {
	const body = new ArrayBuffer(data.byteLength);
	new Uint8Array(body).set(data);
	return new Response(body, {
		headers: { 'content-type': 'application/octet-stream' },
	});
}
