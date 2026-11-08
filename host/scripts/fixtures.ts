/**
 * The fixture identity every scenario drives.
 *
 * Kept apart from the scenario table so the groups that live in their own modules can name the
 * same model and skill without importing the table back (`rules.md#single-file-line-limit`).
 */

/**
 * Provider and model the smoke drives.
 *
 * The defaults name the fixture the driver writes into the data root before any host starts
 * (`models.yml`, `auth: none`), so a run needs no stored credential and no provider the author's
 * machine happens to have - which is what made the previous hard-coded ids unusable everywhere
 * else. A run against a real provider overrides both.
 */
export const OMP_DESKTOP_SMOKE_PROVIDER = process.env.OMP_DESKTOP_SMOKE_PROVIDER ?? 'smoke-local'
export const OMP_DESKTOP_SMOKE_MODEL = process.env.OMP_DESKTOP_SMOKE_MODEL ?? 'smoke-model'
/** The fixture exposes only low/medium; `max` deliberately proves engine adaptation. */
export const OMP_DESKTOP_SMOKE_THINKING = 'max'

/**
 * The second fixture provider, whose credential the `credentials` scenario supplies at runtime.
 *
 * Its `models.yml` entry carries an `apiKey:` that names an environment variable no host under
 * test has set. A custom provider's `apiKey` is resolved as environment-variable-name-or-literal
 * (`docs/providers.md`): the absent variable means the *name itself* is used as the key, so the
 * provider reads as authenticated and its model is listed even though no real credential exists -
 * the pre-fix state this fixture reproduces, and the control the scenario keeps.
 */
export const OMP_DESKTOP_SMOKE_KEYED_PROVIDER = 'smoke-keyed'
export const OMP_DESKTOP_SMOKE_KEYED_MODEL = 'smoke-keyed-model'
export const OMP_DESKTOP_SMOKE_KEYED_ENV = 'OMP_DESKTOP_CUSTOM_SMOKE_KEYED_API_KEY'

/**
 * The skill the driver seeds into the fixture agent directory, and the line its body carries.
 *
 * A user-scope native skill is discovered without any opt-in (`discovery/builtin.ts` scans
 * `<agentDir>/skills`), so the run can prove the `/` palette advertises skills as `/skill:<name>`
 * commands and that invoking one dispatches the skill rather than a plain prompt.
 */
export const OMP_DESKTOP_SMOKE_SKILL = 'smoke-skill'
export const OMP_DESKTOP_SMOKE_SKILL_MARKER = 'SMOKE-SKILL-BODY-MARKER'
