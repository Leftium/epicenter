export class NoopWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = NoopWebSocket.CONNECTING;
	binaryType: BinaryType = 'blob';
	onopen: ((ev: Event) => unknown) | null = null;
	onclose: ((ev: CloseEvent) => unknown) | null = null;
	onerror: ((ev: Event) => unknown) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;

	constructor(
		public readonly url: string,
		_protocols?: string | string[],
	) {}

	send() {}
	close() {
		if (this.readyState === NoopWebSocket.CLOSED) return;
		this.readyState = NoopWebSocket.CLOSED;
		this.onclose?.({ code: 1005, reason: '' } as CloseEvent);
	}
	addEventListener() {}
	removeEventListener() {}
}
