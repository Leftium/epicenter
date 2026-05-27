# Error Flow Patterns

## When to Read This

Read when you need concrete examples of RPC error pass-through or want to avoid double-wrapping tagged errors.

## Real-World Examples

Pass service errors through unchanged:

```typescript
enumerateDevices: defineQuery({
	queryKey: recorderKeys.devices,
	queryFn: async () => {
		const { data, error } = await recorderService().enumerateDevices();
		if (error) return Err(error);
		return Ok(data);
	},
});
```

Add an RPC-local error only when the adapter owns the failure:

```typescript
const TransformerRpcError = defineErrors({
	RecordingNotFound: () => ({
		message: 'Could not find the selected recording.',
	}),
});
type TransformerRpcError = InferErrors<typeof TransformerRpcError>;

transformRecording: defineMutation({
	mutationKey: transformerKeys.transformRecording,
	mutationFn: async ({
		recordingId,
		transformation,
	}: {
		recordingId: string;
		transformation: Transformation;
	}) => {
		const recording = recordings.get(recordingId);
		if (!recording) return TransformerRpcError.RecordingNotFound();

		return runTransformation({
			input: recording.transcript,
			transformation,
			recordingId,
		});
	},
});
```

## Anti-Pattern: Double Wrapping

Do not translate a typed service error into a parallel UI error shape inside `$lib/rpc`:

```typescript
// BAD: the tagged error loses its domain fields before the report boundary.
if (error) {
	return Err({
		title: 'Failed',
		description: error.message,
	});
}

// GOOD: keep the tagged error intact until UI/report code chooses display copy.
if (error) return Err(error);

if (error) {
	report.error({ cause: error });
}
```
