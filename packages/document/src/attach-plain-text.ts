import type * as Y from 'yjs';

export type PlainTextAttachment = {
	binding: Y.Text;
	read: () => string;
	write: (text: string) => void;
};

export function attachPlainText(
	ydoc: Y.Doc,
	key = 'content',
): PlainTextAttachment {
	const ytext = ydoc.getText(key);
	return {
		binding: ytext,
		read() {
			return ytext.toString();
		},
		write(text) {
			ydoc.transact(() => {
				ytext.delete(0, ytext.length);
				ytext.insert(0, text);
			});
		},
	};
}
