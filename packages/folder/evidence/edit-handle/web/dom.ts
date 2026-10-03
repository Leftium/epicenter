/** EXPERIMENT: the one DOM helper the demo's vanilla views use. Text is always set as text. */
export function h<TTag extends keyof HTMLElementTagNameMap>(
	tag: TTag,
	props: Partial<HTMLElementTagNameMap[TTag]> = {},
	...children: (Node | string | false | undefined)[]
): HTMLElementTagNameMap[TTag] {
	const element = Object.assign(document.createElement(tag), props);
	for (const child of children)
		if (child !== false && child !== undefined) element.append(child);
	return element;
}

export function shortSha(sha256: string | undefined): string {
	return sha256 === undefined ? 'none' : sha256.slice(0, 8);
}
