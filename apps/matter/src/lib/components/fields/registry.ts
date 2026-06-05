/**
 * The Kind -> Field component map: the UI layer's half of the contract whose
 * model half is `deriveKind` (schema -> Kind). Keeping them separate is the point:
 * the model layer derives the kind and stays free of component imports; this layer
 * maps the kind to a widget.
 *
 * `satisfies Record<Kind, FieldComponent>` IS the exhaustiveness guarantee: add a
 * Kind to the `KINDS` registry in schema.ts and this object fails to compile until
 * its Field exists. That subsumes the old `kind satisfies never` render-ladder
 * guard (and is strictly stronger: a missing kind is caught at the map literal, not
 * at a fallthrough branch). `number` and `integer` share `NumericField`; `tags` and
 * `multiSelect` share `ChipListField` (both are string lists; their editors fork
 * later); `json` is the unreachable read-only fallback (model.ts rejects json fields).
 */

import type { Component } from 'svelte';
import type { Kind } from '$lib/model/schema';
import BooleanField from './BooleanField.svelte';
import ChipListField from './ChipListField.svelte';
import DateTimeField from './DateTimeField.svelte';
import JsonField from './JsonField.svelte';
import NumericField from './NumericField.svelte';
import SelectField from './SelectField.svelte';
import StringField from './StringField.svelte';
import type { FieldProps } from './types';
import UrlField from './UrlField.svelte';

export type FieldComponent = Component<FieldProps>;

export const FIELD_COMPONENTS = {
	string: StringField,
	integer: NumericField,
	number: NumericField,
	boolean: BooleanField,
	datetime: DateTimeField,
	url: UrlField,
	select: SelectField,
	multiSelect: ChipListField,
	tags: ChipListField,
	json: JsonField,
} satisfies Record<Kind, FieldComponent>;
