<!--
	Setup wizard chrome. Each step is its own route (`/setup`, `/setup/access`,
	`/setup/activation`, `/setup/practice`); this layout renders the shared title,
	stepper, per-step heading, and Back/Continue, and animates the active step body
	as the route changes. The router owns step switching — there's no `{#if}` here.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import CheckCircle2Icon from '@lucide/svelte/icons/check-circle-2';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import { onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { cubicOut } from 'svelte/easing';
	import { fly } from 'svelte/transition';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { getReadiness, permissions, practice } from './setup-state.svelte';

	type StepId = 'engine' | 'access' | 'activation' | 'practice';

	let { children } = $props();

	const STEP_IDS = ['engine', 'access', 'activation', 'practice'] as const;

	const readiness = $derived(getReadiness());

	const steps = $derived([
		{
			id: 'engine',
			label: 'Engine',
			title: 'Transcription engine',
			helper:
				'Parakeet runs locally on this device — no account or API key needed. Prefer a cloud provider? Pick it below.',
			status: readiness.runtimeReady ? 'ready' : 'blocked',
		},
		{
			id: 'access',
			label: 'Access',
			title: 'Recording access',
			helper: readiness.needsDesktopPermissions
				? 'Grant microphone and accessibility access so Whispering can hear you and type for you.'
				: 'Confirm Whispering can reach your microphone.',
			status: readiness.accessReady ? 'ready' : 'blocked',
		},
		{
			id: 'activation',
			label: 'Activation',
			title: 'Activation',
			helper:
				'Choose how you start a recording — a shortcut, push to talk, or file upload.',
			status: readiness.activationReady ? 'ready' : 'blocked',
		},
		{
			id: 'practice',
			label: 'Practice',
			title: 'First dictation',
			helper: 'Record one short phrase to confirm everything works end to end.',
			status: practice.succeeded ? 'ready' : 'blocked',
		},
	] as const);

	/** `/setup` is the engine step; `/setup/<id>` is the rest. */
	function stepFromPath(pathname: string): StepId {
		const lastSegment = pathname.replace(/\/$/, '').split('/').pop();
		const matched = STEP_IDS.find((id) => id === lastSegment);
		return matched ?? 'engine';
	}
	const activeStep = $derived(stepFromPath(page.url.pathname));
	const activeIndex = $derived(STEP_IDS.indexOf(activeStep));
	const currentStep = $derived(steps[activeIndex]!);

	const isFirstStep = $derived(activeIndex === 0);
	const isLastStep = $derived(activeIndex === STEP_IDS.length - 1);

	const primaryLabel = $derived(
		isLastStep
			? practice.succeeded
				? 'Start using Whispering'
				: 'Finish without practice'
			: 'Continue',
	);
	const primaryDisabled = $derived(
		isLastStep ? !readiness.canFinish : currentStep.status !== 'ready',
	);

	// Slide direction for the step transition: forward (+1) or back (-1).
	let direction = $state(1);

	// Honor the OS "reduce motion" setting: no slide, no duration.
	const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');

	function pathFor(id: StepId) {
		return id === 'engine' ? '/setup' : `/setup/${id}`;
	}

	function navigate(id: StepId) {
		direction = STEP_IDS.indexOf(id) < activeIndex ? -1 : 1;
		void goto(pathFor(id), { keepFocus: true, noScroll: true });
	}

	/** Reachable if already passed, or individually ready. */
	function isReachable(index: number) {
		return index <= activeIndex || steps[index]?.status === 'ready';
	}

	function handlePrimary() {
		if (isLastStep) {
			void goto('/');
			return;
		}
		navigate(STEP_IDS[activeIndex + 1]!);
	}

	function handleBack() {
		if (!isFirstStep) navigate(STEP_IDS[activeIndex - 1]!);
	}

	onMount(() => {
		void permissions.refresh();
	});
</script>

<svelte:head> <title>Setup - Whispering</title> </svelte:head>
<svelte:window
	onfocus={() => {
		void permissions.refresh();
	}}
/>

<main class="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
	<SectionHeader.Root class="space-y-1">
		<SectionHeader.Title level={1} class="text-3xl tracking-tight">
			Set up Whispering
		</SectionHeader.Title>
		<SectionHeader.Description>
			Get to one successful dictation on this device.
		</SectionHeader.Description>
	</SectionHeader.Root>

	<!-- Progress stepper: the only progress indicator on the page. -->
	<nav class="flex items-stretch gap-2" aria-label="Setup progress">
		{#each steps as step, index (step.id)}
			{@const done = step.status === 'ready'}
			{@const current = index === activeIndex}
			<button
				type="button"
				disabled={!isReachable(index)}
				aria-current={current ? 'step' : undefined}
				onclick={() => navigate(step.id)}
				class="flex flex-1 flex-col gap-1.5 rounded-md text-left transition disabled:cursor-default"
				class:opacity-50={!current && !done}
			>
				<span
					class="h-1 w-full rounded-full transition-colors"
					class:bg-green-500={done}
					class:bg-foreground={current && !done}
					class:bg-border={!current && !done}
				></span>
				<span class="flex items-center gap-1.5 text-xs font-medium">
					{#if done}
						<CheckCircle2Icon class="size-3.5 text-green-500" />
					{:else}
						<CircleIcon
							class="size-3.5 {current
								? 'text-foreground'
								: 'text-muted-foreground'}"
						/>
					{/if}
					<span class={current || done ? 'text-foreground' : 'text-muted-foreground'}>
						{index + 1}. {step.label}
					</span>
				</span>
			</button>
		{/each}
	</nav>

	{#key activeStep}
		<div
			class="flex flex-col gap-5"
			in:fly={{
				x: reducedMotion.current ? 0 : 12 * direction,
				duration: reducedMotion.current ? 0 : 150,
				easing: cubicOut,
			}}
		>
			<div class="space-y-1">
				<h2 class="text-base font-medium">{currentStep.title}</h2>
				<p class="text-sm text-muted-foreground">{currentStep.helper}</p>
			</div>
			{@render children()}
		</div>
	{/key}

	<div class="flex items-center justify-between">
		<Button variant="outline" disabled={isFirstStep} onclick={handleBack}>
			<ArrowLeftIcon class="size-4" />
			Back
		</Button>
		<Button disabled={primaryDisabled} onclick={handlePrimary}>
			{primaryLabel}
			{#if !isLastStep}
				<ArrowRightIcon class="size-4" />
			{/if}
		</Button>
	</div>
</main>
