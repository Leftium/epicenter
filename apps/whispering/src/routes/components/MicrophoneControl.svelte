<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import * as Popover from '@epicenter/ui/popover';
	import { Progress } from '@epicenter/ui/progress';
	import * as RadioGroup from '@epicenter/ui/radio-group';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { cn } from '@epicenter/ui/utils';
	import MicIcon from '@lucide/svelte/icons/mic';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { untrack } from 'svelte';
	import { getSession } from '$lib/session.svelte.js';
	import { returnFocusToTrigger } from './option-popover-focus.js';

	/**
	 * The microphone the next recording uses. Opening this lists what the
	 * WebView already knows and asks for nothing; Enable microphones and Test
	 * microphone are the two actions that open one, and whichever is under
	 * way ends when this closes or the page is left. The recorder owns which
	 * option popover is open.
	 */
	let { open = $bindable(false) }: { open?: boolean } = $props();
	let trigger = $state<HTMLElement | null>(null);
	let content = $state<HTMLElement | null>(null);

	const { library } = getSession();
	const input = library.input;
	const capture = library.workspace.capture;

	/** A recording keeps the microphone it opened, so the choice waits for it to end. */
	const locked = $derived(library.recorder.phase !== 'idle');
	const devices = $derived(input.list.kind === 'listed' ? input.list.devices : []);
	/** Whether the choice's own ID is listed. A listed input with the same name is not it. */
	const listed = $derived(devices.some((device) => device.deviceId === input.choice?.deviceId));
	/** Inputs are named only after access is allowed; until then enabling is the one thing to do. */
	const unnamed = $derived(input.list.kind === 'listed' && devices.length === 0);
	const name = $derived(
		!input.available ? 'Fixture audio' : input.choice === undefined ? 'System default' : input.choice.label || 'Chosen microphone',
	);

	/**
	 * What is wrong with the choice, for the trigger. An input that is not
	 * listed counts only once inputs are listed by name: before access is
	 * allowed nothing is listed, and that says nothing about the choice.
	 */
	const warning = $derived(
		!input.available
			? undefined
			: input.denied
				? 'Microphone access was denied'
				: input.choiceListed === false
					? 'This input is not listed'
					: input.preferenceProblem
						? input.preferenceProblem
						: undefined,
	);
	/** The trigger is an icon, so this is its whole name: what it is, what is chosen, and what is wrong. */
	const summary = $derived(`Microphone input: ${name}${warning ? `. ${warning}.` : ''}`);
	let hinting = $state(false);

	// Radio values: a listed ID never equals the system default's value.
	const SYSTEM = 'system';
	const valueOf = (deviceId: string) => `device:${deviceId}`;
	const value = $derived(input.choice === undefined ? SYSTEM : valueOf(input.choice.deviceId));

	function choose(next: string) {
		const device = devices.find((item) => valueOf(item.deviceId) === next);
		// A value that is neither is the unlisted choice itself, which is already chosen.
		if (next === SYSTEM || device !== undefined) void input.select(device);
	}

	// While this is the open popover the inputs are listed. When it stops being
	// open, however that happened (dismissed, another option opened, the page
	// left), whatever it was opening or testing is released.
	$effect(() => {
		if (!open) return;
		untrack(() => void input.refresh());
		return () => input.release();
	});
</script>

<Popover.Root bind:open>
	<!-- The hint is composed here, not through the button's own tooltip, so it can be held shut while the popover is open and never takes its Escape. -->
	<Tooltip.Root disabled={open} bind:open={() => hinting && !open, (next) => (hinting = next)}>
		<Tooltip.Trigger>
			{#snippet child({ props: hint })}
				<Popover.Trigger {...hint}>
					{#snippet child({ props })}
						<Button
							{...props}
							bind:ref={trigger}
							variant="ghost"
							size="icon"
							aria-label={summary}
							data-testid="microphone-control"
						>
							<MicIcon class={cn('text-muted-foreground', !warning && input.choice && input.choiceListed === true && 'text-success brightness-75 dark:brightness-100', warning && 'text-warning')} />
						</Button>
					{/snippet}
				</Popover.Trigger>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content side="bottom" class="max-w-xs text-center">{summary}</Tooltip.Content>
	</Tooltip.Root>
	<Popover.Content
		bind:ref={content}
		onCloseAutoFocus={(event) => returnFocusToTrigger(event, trigger, content)}
		side="bottom"
		collisionPadding={8}
		class="max-h-(--bits-popover-content-available-height) w-72 max-w-[calc(100vw-1rem)] gap-3 overflow-y-auto"
		data-testid="microphone-popover"
	>
		{#if !input.available}
			<p class="font-medium">No real input</p>
			<p class="text-xs text-muted-foreground" data-testid="microphone-fixture">
				Recordings use {capture.label}. No microphone is listed, asked for, or opened.
			</p>
		{:else}
			<div class="flex items-center gap-2">
				<p class="flex-1 font-medium" id="microphone-input-heading">Microphone input</p>
				<!-- No tooltip: this takes focus when the popover opens, and a tooltip there would take the first Escape. -->
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label="List inputs again"
					disabled={input.listing}
					onclick={() => void input.refresh()}
					data-testid="microphone-refresh"
				>
					{#if input.listing}<Spinner />{:else}<RefreshCwIcon />{/if}
				</Button>
			</div>

			<RadioGroup.Root {value} onValueChange={choose} disabled={locked} aria-labelledby="microphone-input-heading" class="gap-2">
				<div class="flex items-center gap-2">
					<RadioGroup.Item value={SYSTEM} id="microphone-system" />
					<Label for="microphone-system" class="font-normal">System default</Label>
				</div>
				{#each devices as device, index (device.deviceId)}
					<div class="flex items-center gap-2">
						<RadioGroup.Item value={valueOf(device.deviceId)} id="microphone-{index}" />
						<Label for="microphone-{index}" class="min-w-0 font-normal"><span class="truncate">{device.label}</span></Label>
					</div>
				{/each}
				{#if input.choice && !listed}
					<!-- The choice is kept as it is: it is never swapped for a microphone that happens to be listed. -->
					<div class="flex items-center gap-2" data-testid="microphone-unlisted">
						<RadioGroup.Item value={valueOf(input.choice.deviceId)} id="microphone-chosen" />
						<Label for="microphone-chosen" class="min-w-0 font-normal">
							<span class="truncate">{input.choice.label || 'Chosen microphone'}</span>
							<span class="shrink-0 text-xs text-warning">not listed</span>
						</Label>
					</div>
				{/if}
			</RadioGroup.Root>

			{#if input.list.kind === 'unsupported' || input.list.kind === 'failed'}
				<p class="text-xs text-destructive" role="alert" data-testid="microphone-list-problem">{input.list.message}</p>
			{:else if locked}
				<p class="text-xs text-muted-foreground" role="status">In use by this recording. Change it when the recording ends.</p>
			{:else if input.choiceListed === false}
				<p class="text-xs text-warning" role="status" data-testid="microphone-unlisted-note">
					This input is not listed. If it cannot be opened, recording will not start and no other microphone is used
					in its place.
				</p>
			{:else if unnamed}
				<p class="text-xs text-muted-foreground" data-testid="microphone-unnamed">
					{input.list.kind === 'listed' && input.list.namesWithheld
						? 'Microphones are listed by name once you allow access.'
						: 'No microphone is listed. Allowing access may show them.'}
				</p>
			{/if}

			{#if input.test.phase === 'running'}
				<div class="flex flex-col gap-1.5" data-testid="microphone-meter">
					<Progress value={Math.round(input.level * 100)} aria-label="Input level of {input.test.label}" />
					<p class="text-xs text-muted-foreground">Listening to {input.test.label}. Nothing is recorded.</p>
				</div>
			{/if}
			{#if input.problem}
				<p class="text-xs text-destructive" role="alert" data-testid="microphone-problem">{input.problem}</p>
			{/if}
			{#if input.preferenceProblem}
				<p class="text-xs text-destructive" role="alert">Microphone setting: {input.preferenceProblem}</p>
			{/if}

			<!-- One action at a time: enabling while nothing is named, otherwise the test. -->
			{#if input.test.phase !== 'idle'}
				<Button size="sm" variant="outline" onclick={() => input.release()} data-testid="microphone-test-stop">
					{#if input.test.phase === 'opening'}<Spinner class="size-3.5" />{/if}
					Stop test
				</Button>
			{:else if unnamed}
				<Button
					size="sm"
					tooltip="Opens the default microphone for a moment. Nothing is recorded."
					disabled={locked || input.allowing}
					onclick={() => void input.allow()}
					data-testid="microphone-enable"
				>
					{#if input.allowing}<Spinner class="size-3.5" />{/if}
					Enable microphones
				</Button>
			{:else}
				<Button size="sm" variant="outline" disabled={locked || input.allowing} onclick={() => void input.startTest()} data-testid="microphone-test">
					Test microphone
				</Button>
			{/if}
			{#if !locked}
				<p class="text-xs text-muted-foreground">Applies to the next recording.</p>
			{/if}
		{/if}
	</Popover.Content>
</Popover.Root>
