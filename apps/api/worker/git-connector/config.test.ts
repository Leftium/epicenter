import { expect, test } from 'bun:test';
import { gitHubConnectorCallbacks, ZHONGWEN_SYNC_CALLBACK } from './config.js';

test('a local API admits the two exact Zhongwen development callbacks', () => {
	for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787']) {
		expect(gitHubConnectorCallbacks(origin)).toEqual([
			ZHONGWEN_SYNC_CALLBACK,
			'http://localhost:5207/sync',
			'http://127.0.0.1:5207/sync',
		]);
	}
});

test('a deployed API admits no development callback', () => {
	expect(gitHubConnectorCallbacks('https://api.epicenter.so')).toEqual([
		ZHONGWEN_SYNC_CALLBACK,
	]);
});
