import Field from './field.svelte';
import Content from './field-content.svelte';
import Description from './field-description.svelte';
// biome-ignore lint/suspicious/noShadowRestrictedNames: Component name matches its purpose
import Error from './field-error.svelte';
import Group from './field-group.svelte';
import Label from './field-label.svelte';
import Legend from './field-legend.svelte';
import Separator from './field-separator.svelte';
// biome-ignore lint/suspicious/noShadowRestrictedNames: Component name matches its purpose
import Set from './field-set.svelte';
import Title from './field-title.svelte';

export {
	Field,
	Set,
	Legend,
	Group,
	Content,
	Label,
	Title,
	Description,
	Separator,
	Error,
	//
	Set as FieldSet,
	Legend as FieldLegend,
	Group as FieldGroup,
	Content as FieldContent,
	Label as FieldLabel,
	Title as FieldTitle,
	Description as FieldDescription,
	Separator as FieldSeparator,
	Error as FieldError,
};
