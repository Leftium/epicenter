/** Portable discovery JSON from an application's prepared definition. */
import type { TSchema } from 'typebox';
import { Format } from 'typebox/format';
import * as Schema from 'typebox/schema';
import { Hashing } from 'typebox/system';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { type Result, trySync } from 'wellcrafted/result';
import type { DataSchema } from './declaration.js';
import type { JsonObject, JsonValue } from './json.js';
import { hasSchemaCallbacks, isPreparedSchema } from './prepare.js';

// Compare against TypeBox's stock handlers, not a registry snapshot that an
// application may already have changed before this module was imported.
const portableFormats = new Map<string, (value: string) => boolean>([
	['date-time', Format.IsDateTime],
	['date', Format.IsDate],
	['duration', Format.IsDuration],
	['email', Format.IsEmail],
	['hostname', Format.IsHostname],
	['idn-email', Format.IsIdnEmail],
	['idn-hostname', Format.IsIdnHostname],
	['ipv4', Format.IsIPv4],
	['ipv6', Format.IsIPv6],
	['iri-reference', Format.IsIriReference],
	['iri', Format.IsIri],
	['json-pointer-uri-fragment', Format.IsJsonPointerUriFragment],
	['json-pointer', Format.IsJsonPointer],
	['regex', Format.IsRegex],
	['relative-json-pointer', Format.IsRelativeJsonPointer],
	['time', Format.IsTime],
	['uri-reference', Format.IsUriReference],
	['uri-template', Format.IsUriTemplate],
	['uri', Format.IsUri],
	['url', Format.IsUrl],
	['uuid', Format.IsUuid],
]);

export const DefinitionExportError = defineErrors({
	Unsupported: ({ cause }: { cause: unknown }) => ({
		message: 'The definition cannot be exported faithfully as JSON.',
		cause,
	}),
});
export type DefinitionExportError = InferErrors<typeof DefinitionExportError>;

/**
 * Serialize prepared title, KV, and tables, excluding dataset identity.
 * Hidden data properties are included unless they change native map iteration
 * or compiled-function sharing. Fidelity targets TypeBox 1.1.23 in the same
 * evaluation mode; it does not reconcile native compiled/interpreted differences.
 * Runtime callbacks, guards, codecs, and non-JSON values refuse the whole
 * export. No callback or toJSON method is invoked. Own property order is preserved;
 * array order is preserved. Body conversions cannot be described by JSON.
 */
export function exportSchema(
	prepared: DataSchema,
): Result<string, DefinitionExportError> {
	return trySync({
		try: () => {
			if (!isPreparedSchema(prepared))
				throw new Error('Export requires a prepared definition');
			for (const [name, table] of Object.entries(prepared.tables))
				if (table.body !== undefined)
					throw new Error(`tables.${name}.body is a runtime conversion`);
			const copies = new WeakMap<object, JsonValue>();
			const portable = jsonCopy(
				{
					...(prepared.title === undefined ? {} : { title: prepared.title }),
					kv: prepared.kv,
					tables: prepared.tables,
				},
				'$',
				new Set(),
				copies,
			);
			for (const [name, schema] of Object.entries(prepared.kv))
				checkSchemaExport(schema, `$.kv.${name}`, copies);
			for (const [tableName, table] of Object.entries(prepared.tables))
				for (const [name, schema] of Object.entries(table.fields))
					checkSchemaExport(
						schema,
						`$.tables.${tableName}.fields.${name}`,
						copies,
					);
			return `${JSON.stringify(portable, null, 2)}\n`;
		},
		catch: (cause) => DefinitionExportError.Unsupported({ cause }),
	});
}

/**
 * TypeBox enumerates these maps, while it reads direct keywords and resolves
 * references through all own names. Making a hidden map entry enumerable can
 * change validation. Visit schema positions, including reference targets, so
 * an ordinary field named `properties` is never mistaken for this keyword.
 * Materialization must also preserve which compiled functions TypeBox shares.
 * Its function hash spreads top-level keywords, dropping hidden ones, while
 * hashing all own names deeper down. Check both cache splits and merges.
 * The JSON copy above has already refused accessors and runtime dependencies.
 */
function checkSchemaExport(
	root: TSchema & object,
	path: string,
	copies: WeakMap<object, JsonValue>,
) {
	if (hasSchemaCallbacks(root))
		throw new Error(`${path} has a prepared validator with runtime callbacks`);
	const visited = new WeakMap<
		object,
		{
			baseUrl: string;
			base: object;
			recursiveAnchor: object | undefined;
		}[]
	>();
	const exportedHashes = new Map<string, string>();
	const originalHashes = new Map<string, string>();
	function checkCompiledSharing(
		schema: unknown,
		path: string,
		baseUrl: string,
	) {
		const portable = Schema.IsSchemaObject(schema)
			? copies.get(schema)
			: typeof schema === 'number' && schema === 0
				? 0
				: schema;
		if (Schema.IsSchemaObject(schema) && portable === undefined)
			throw new Error(`${path} resolves outside the owned schema snapshot`);
		const hash = (value: unknown) =>
			Hashing.Hash(
				Schema.IsSchemaObject(value) ? { __baseURL: baseUrl, ...value } : value,
			);
		const original = hash(schema);
		const exported = hash(portable);
		if (
			(exportedHashes.has(original) &&
				exportedHashes.get(original) !== exported) ||
			(originalHashes.has(exported) &&
				originalHashes.get(exported) !== original)
		)
			throw new Error(`${path} changes compiled validator cache sharing`);
		exportedHashes.set(original, exported);
		originalHashes.set(exported, original);
	}
	function visit(
		schema: unknown,
		path: string,
		base: object,
		recursiveAnchor: object | undefined,
		baseUrl: string,
		compiled = false,
	): void {
		// CreateFunction hashes before BuildSchema pushes the target's $id.
		if (compiled) checkCompiledSharing(schema, path, baseUrl);
		if (!Schema.IsSchemaObject(schema)) return;
		if (Schema.IsId(schema)) {
			base = schema;
			baseUrl = new URL(schema.$id, baseUrl).href;
		}
		if (Schema.IsRecursiveAnchorTrue(schema)) recursiveAnchor ??= schema;
		const scopes = visited.get(schema) ?? [];
		if (
			scopes.some(
				(scope) =>
					scope.baseUrl === baseUrl &&
					scope.base === base &&
					scope.recursiveAnchor === recursiveAnchor,
			)
		)
			return;
		scopes.push({ baseUrl, base, recursiveAnchor });
		visited.set(schema, scopes);
		const descriptors = Object.getOwnPropertyDescriptors(schema);
		for (const keyword of [
			'properties',
			'patternProperties',
			'dependencies',
			'dependentSchemas',
			'dependentRequired',
			'$defs',
			'definitions',
		]) {
			const map: unknown = descriptors[keyword]?.value;
			if (typeof map !== 'object' || map === null) continue;
			for (const [name, descriptor] of Object.entries(
				Object.getOwnPropertyDescriptors(map),
			)) {
				if (Array.isArray(map) && name === 'length') continue;
				if (
					keyword !== '$defs' &&
					keyword !== 'definitions' &&
					!descriptor.enumerable
				)
					throw new Error(`${path}.${keyword}.${name} is a hidden map entry`);
				if (keyword !== 'dependentRequired')
					visit(
						descriptor.value,
						`${path}.${keyword}.${name}`,
						base,
						recursiveAnchor,
						baseUrl,
					);
			}
		}
		for (const keyword of [
			'additionalItems',
			'additionalProperties',
			'contains',
			'propertyNames',
			'not',
			'if',
			'then',
			'else',
			'unevaluatedItems',
			'unevaluatedProperties',
			'items',
			'allOf',
			'anyOf',
			'oneOf',
			'prefixItems',
		]) {
			const child: unknown = descriptors[keyword]?.value;
			if (Array.isArray(child)) {
				for (const [index, member] of child.entries())
					visit(
						member,
						`${path}.${keyword}.${index}`,
						base,
						recursiveAnchor,
						baseUrl,
					);
			} else visit(child, `${path}.${keyword}`, base, recursiveAnchor, baseUrl);
		}
		if (Schema.IsRef(schema)) {
			visit(
				Schema.Resolve.Ref(
					schema.$ref.startsWith('#') ? base : root,
					schema.$ref,
				) ?? false,
				`${path}.$ref`,
				base,
				recursiveAnchor,
				baseUrl,
				true,
			);
		}
		if (Schema.IsRecursiveRef(schema)) {
			visit(
				Schema.Resolve.Ref(
					Schema.IsRecursiveAnchorTrue(base) ? (recursiveAnchor ?? base) : base,
					schema.$recursiveRef,
				) ?? false,
				`${path}.$recursiveRef`,
				base,
				recursiveAnchor,
				baseUrl,
				true,
			);
		}
	}
	visit(root, path, root, undefined, new URL('http://unknown').href, true);
}

/** Inspect descriptors rather than letting JSON.stringify silently omit data. */
function jsonCopy(
	value: unknown,
	path: string,
	ancestors: Set<object>,
	copies: WeakMap<object, JsonValue>,
): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return value;
	// Match JSON's -0 to 0 conversion before comparing TypeBox's IEEE754 hashes.
	if (typeof value === 'number' && Number.isFinite(value))
		return value === 0 ? 0 : value;
	if (typeof value !== 'object' || value === null)
		throw new Error(`${path} holds a non-JSON ${typeof value}`);
	if (ancestors.has(value)) throw new Error(`${path} is cyclic`);
	const array = Array.isArray(value);
	const prototype = Object.getPrototypeOf(value);
	if (!array && prototype !== Object.prototype && prototype !== null)
		throw new Error(`${path} is not a plain JSON object`);
	// Conservative refusal anywhere, including annotation data: a guard node
	// can replace keyword checks and TypeBox retains it by reference.
	if ('~guard' in value) throw new Error(`${path} holds a runtime guard`);
	if (Object.getOwnPropertySymbols(value).length > 0)
		throw new Error(`${path} holds symbol properties`);
	ancestors.add(value);
	try {
		const keys = Object.getOwnPropertyNames(value).filter(
			(key) => !array || key !== 'length',
		);
		if (
			array &&
			(keys.length !== value.length ||
				keys.some(
					(key) =>
						!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length,
				))
		)
			throw new Error(`${path} is sparse or holds non-index properties`);
		const copy: JsonObject | JsonValue[] = array ? [] : Object.create(null);
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			if (!('value' in descriptor))
				throw new Error(`${path}.${key} is an accessor`);
			if (key === 'format' && typeof descriptor.value === 'string') {
				const stock = portableFormats.get(descriptor.value);
				if (stock === undefined || Format.Get(descriptor.value) !== stock)
					throw new Error(
						`${path}.format depends on an unsupported format handler: ${descriptor.value}`,
					);
			}
			const child = jsonCopy(
				descriptor.value,
				`${path}.${key}`,
				ancestors,
				copies,
			);
			if (Array.isArray(copy)) copy.push(child);
			else copy[key] = child;
		}
		copies.set(value, copy);
		return copy;
	} finally {
		ancestors.delete(value);
	}
}
