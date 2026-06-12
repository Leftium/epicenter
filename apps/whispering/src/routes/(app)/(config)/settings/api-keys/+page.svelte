<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Field from '@epicenter/ui/field';
	import * as Tabs from '@epicenter/ui/tabs';
	import {
		ApiKeyInput,
		type ApiKeyProvider,
	} from '$lib/components/settings';

	const TRANSCRIPTION: ApiKeyProvider[] = [
		'Groq',
		'OpenAI',
		'ElevenLabs',
		'Deepgram',
		'Mistral',
	];
	const TRANSFORMATION: ApiKeyProvider[] = [
		'Google',
		'Anthropic',
		'OpenAI',
		'Groq',
		'Mistral',
		'OpenRouter',
		'Custom',
	];

	const TABS = [
		{
			value: 'all',
			label: 'All',
			providers: [...new Set([...TRANSCRIPTION, ...TRANSFORMATION])],
		},
		{ value: 'transcription', label: 'Transcription', providers: TRANSCRIPTION },
		{
			value: 'transformation',
			label: 'Transformation',
			providers: TRANSFORMATION,
		},
	];
</script>

<svelte:head> <title>API Keys - Whispering</title> </svelte:head>

<Field.Set>
	<Field.Legend>API Keys</Field.Legend>
	<Field.Description>Configure your API keys for Whispering.</Field.Description>
	<Field.Separator />

	<Tabs.Root value="all" class="w-full">
		<Tabs.List class="grid w-full grid-cols-3">
			{#each TABS as tab (tab.value)}
				<Tabs.Trigger value={tab.value}>
					{tab.label}
					<Badge variant="secondary">{tab.providers.length}</Badge>
				</Tabs.Trigger>
			{/each}
		</Tabs.List>

		{#each TABS as tab (tab.value)}
			<Tabs.Content value={tab.value} class="mt-4">
				<Field.Group>
					{#each tab.providers as provider, i (provider)}
						{#if i > 0}
							<Field.Separator />
						{/if}
						<ApiKeyInput {provider} />
					{/each}
				</Field.Group>
			</Tabs.Content>
		{/each}
	</Tabs.Root>
</Field.Set>
