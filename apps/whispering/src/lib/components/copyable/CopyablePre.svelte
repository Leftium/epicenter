<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const copyableVariants = tv({
		base: 'relative whitespace-normal rounded p-4 pr-12 text-sm',
		variants: {
			variant: {
				code: 'bg-muted font-mono',
				text: 'bg-muted text-muted-foreground',
				error: 'bg-destructive/10 text-destructive',
			},
		},
	});

	export type CopyableVariants = VariantProps<
		typeof copyableVariants
	>['variant'];
</script>

<script lang="ts">
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { cn } from '@epicenter/ui/utils';
	import { createCopyFn } from '$lib/utils/createCopyFn';

	const {
		copyableText,
		variant,
		class: className,
	}: {
		copyableText: string;
		variant: CopyableVariants;
		class?: string;
	} = $props();
</script>

<pre class={cn(copyableVariants({ variant }), className)}>
{copyableText}
	<CopyButton
		class="absolute right-4 top-1/2 -translate-y-1/2"
		copyFn={createCopyFn(variant === 'code' ? 'code' : 'transcript')}
		text={copyableText}
	/>
</pre>
