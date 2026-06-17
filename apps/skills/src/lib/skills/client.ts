import { openSkillsBrowser } from '@epicenter/skills/browser';

export const skills = openSkillsBrowser();

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		skills[Symbol.dispose]();
	});
}
