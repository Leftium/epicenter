import type { AnyTaggedError } from 'wellcrafted/error';

export type NoticeAction = {
	label: string;
	onClick: () => void | Promise<void>;
};

export type Notice = {
	title?: string;
	description?: string;
	action?: NoticeAction;
	cause?: AnyTaggedError;
};

export type Problem = Notice & { cause: AnyTaggedError };

export type Level = 'error' | 'success' | 'info' | 'loading';
