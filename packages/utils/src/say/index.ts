/**
 * `say` — TypeScript-enforced polyglot strings, framework-agnostic.
 *
 * A "polyglot value" is a plain object literal with one string per
 * supported language:
 *
 *     { en: 'Hello', es: 'Hola' }
 *
 * The keys are the source of truth. There is no JSON file, no key
 * registry, no extraction tool, no namespaces. The TS compiler
 * enforces completeness: add a language to the plugin's `supported`
 * list and every call site without that key becomes a compile error.
 *
 * Two entry points:
 *
 *   `say(value, lang)`  — pure resolver, no context, returns string.
 *                          Use it for 3rd-party SDKs / cron / email
 *                          / anything outside a bot ctx.
 *
 *   `ctx.say(value)`     — bot-bound; uses `ctx.lang`. Provided by
 *                          `bot/language` (see that plugin for the
 *                          `ctx.say.send / .edit / .answer` methods).
 *
 * @example
 * import { say, type Polyglot } from '@adriangalilea/utils/say'
 *
 * await pushover.send({
 *   message: say({ en: 'Drop!', es: '¡Drop!' }, user.lang),
 * })
 *
 * // typing your own adapter:
 * const notify = (msg: string | Polyglot<'en' | 'es'>, lang: 'en' | 'es') =>
 *   transport.send(typeof msg === 'string' ? msg : say(msg, lang))
 */

/**
 * A value that exists in N languages. `L` is the union of supported
 * language tags (typically inferred from the object literal's keys).
 *
 * Authoring: `{ en: 'Hi', es: 'Hola' }` — TS infers `L = 'en' | 'es'`.
 *
 * Typing your own API: `function notify(msg: Polyglot<'en' | 'es'>)`
 * — callers must provide both keys.
 */
export type Polyglot<L extends string> = Readonly<Record<L, string>>;

/**
 * Resolve a polyglot value to a string at `lang`.
 *
 * If `lang` is missing from `value`, returns the first available key
 * (lexicographic). This is a structural fallback — it should never
 * happen when `lang` is constrained by the same `L` as `value`'s
 * keys; it exists only for the dynamic-string escape hatch.
 *
 * @example
 * say({ en: 'Hi', es: 'Hola' }, 'es')           // → 'Hola'
 * say({ en: 'Hi', es: 'Hola' }, 'fr')           // TS error: '"fr"' not in '"en" | "es"'
 *
 * @example  // typing-loose escape hatch with `as Polyglot<string>`
 * const raw: Polyglot<string> = JSON.parse(blob)
 * say(raw, userLang)                            // dynamic, falls back if missing
 */
export const say = <L extends string>(value: Polyglot<L>, lang: L): string => {
	const direct = value[lang];
	if (typeof direct === "string") return direct;
	for (const k in value) return value[k as L];
	return "";
};
