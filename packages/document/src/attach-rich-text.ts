import * as Y from 'yjs';

export type RichTextAttachment = {
	binding: Y.XmlFragment;
	read: () => string;
	write: (text: string) => void;
};

export function attachRichText(
	ydoc: Y.Doc,
	key = 'content',
): RichTextAttachment {
	const fragment = ydoc.getXmlFragment(key);
	return {
		get binding() {
			return fragment;
		},
		read() {
			return fragmentToPlaintext(fragment);
		},
		write(text) {
			ydoc.transact(() => {
				while (fragment.length > 0) {
					fragment.delete(0, 1);
				}
				const paragraph = new Y.XmlElement('paragraph');
				paragraph.insert(0, [new Y.XmlText(text)]);
				fragment.insert(0, [paragraph]);
			});
		},
	};
}

function fragmentToPlaintext(fragment: Y.XmlFragment): string {
	let out = '';
	for (const child of fragment.toArray()) {
		if (child instanceof Y.XmlText) out += child.toString();
		else if (child instanceof Y.XmlElement)
			out += fragmentToPlaintext(child as unknown as Y.XmlFragment);
	}
	return out;
}
