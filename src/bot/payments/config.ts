/**
 * Construction-time validation + catalog build.
 *
 * `validateConfig(cfg)` is the gate. It throws `Panic` on every shape
 * problem the bot author can introduce — a misconfigured payments
 * plugin should scream at startup, not silently misbehave at runtime
 * (see `src/offensive.ts` and CLAUDE.md §"Failure modes").
 *
 * `buildCatalog(cfg)` produces the normalized `ProductCatalog` the rest
 * of the plugin consults (positional ids resolved, polyglots passed
 * through, O(1) lookup by ProductKey).
 *
 * Both are pure — no gramio, no storage, no side effects.
 */

import { panic } from "../../offensive.js";
import type { Polyglot } from "../../say/index.js";
import {
	type BotPaymentsConfig,
	type CreditsPackResolved,
	type PerkResolved,
	type ProductCatalog,
	SUBSCRIPTION_PERIOD_SECONDS,
	type VipRungResolved,
} from "./types.js";

// ─── validation ────────────────────────────────────────────────────

const requireNonEmptyString = (value: unknown, where: string): string => {
	if (typeof value !== "string" || value.length === 0) {
		panic(`bot/payments: ${where} must be a non-empty string (got ${value})`);
	}
	return value as string;
};

const requirePositiveInt = (value: unknown, where: string): number => {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		panic(`bot/payments: ${where} must be a positive integer (got ${value})`);
	}
	return value as number;
};

const polyglotKeys = (p: Polyglot<string>): string[] =>
	Object.keys(p).filter((k) => typeof p[k as keyof typeof p] === "string");

const requirePolyglotCovers = (
	p: Polyglot<string> | undefined,
	locales: ReadonlySet<string>,
	where: string,
): void => {
	if (!p || typeof p !== "object") {
		panic(`bot/payments: ${where} must be a Polyglot object`);
	}
	if (locales.size === 0) return; // no required-locales declared — accept anything non-empty
	for (const loc of locales) {
		const v = (p as Polyglot<string>)[loc];
		if (typeof v !== "string" || v.length === 0) {
			panic(
				`bot/payments: ${where} is missing a non-empty entry for locale "${loc}"`,
			);
		}
	}
};

/**
 * Validates the config and returns the **locales set** that the plugin
 * will use for cross-checking other Polyglots. Derived from
 * `waiver.text` (the single mandatory Polyglot) — every other Polyglot
 * in the config must cover the same locales.
 *
 * Throws `Panic` on any structural problem.
 */
export const validateConfig = (
	cfg: BotPaymentsConfig<string>,
): ReadonlySet<string> => {
	if (!cfg || typeof cfg !== "object") {
		panic("bot/payments: config must be an object");
	}

	requireNonEmptyString(cfg.paysupport, "paysupport");
	requireNonEmptyString(cfg.legal?.sellerName, "legal.sellerName");
	requireNonEmptyString(cfg.legal?.nif, "legal.nif");
	// termsUrl and privacyUrl are OPTIONAL. privacyUrl gets a sensible
	// Telegram-side default at use time (waiver.ts). termsUrl, when
	// omitted, hides the 📖 Terms button from the consent prompt — no
	// canonical Telegram ToS to fall back to.
	if (cfg.legal?.termsUrl !== undefined) {
		requireNonEmptyString(cfg.legal.termsUrl, "legal.termsUrl");
	}
	if (cfg.legal?.privacyUrl !== undefined) {
		requireNonEmptyString(cfg.legal.privacyUrl, "legal.privacyUrl");
	}

	requireNonEmptyString(cfg.waiver?.version, "waiver.version");
	const waiverKeys = polyglotKeys(cfg.waiver?.text ?? ({} as Polyglot<string>));
	if (waiverKeys.length === 0) {
		panic(
			"bot/payments: waiver.text must declare at least one locale with non-empty content",
		);
	}
	const locales = new Set(waiverKeys);

	const hasVip = Array.isArray(cfg.vip) && cfg.vip.length > 0;
	const hasCredits =
		!!cfg.credits &&
		Array.isArray(cfg.credits.packs) &&
		cfg.credits.packs.length > 0;
	const hasPerks = !!cfg.perks && Object.keys(cfg.perks).length > 0;
	if (!hasVip && !hasCredits && !hasPerks) {
		panic(
			"bot/payments: declare at least one of `vip`, `credits.packs`, or `perks` — " +
				"a payments plugin with no products has nothing to sell",
		);
	}

	if (hasVip) {
		cfg.vip?.forEach((rung, i) => {
			const at = `vip[${i}]`;
			requirePositiveInt(rung.xtr, `${at}.xtr`);
			if (rung.period !== "30d") {
				panic(
					`bot/payments: ${at}.period must be "30d" (Telegram supports no other ` +
						`subscription period as of 2026) — got "${rung.period}"`,
				);
			}
			requirePolyglotCovers(rung.name, locales, `${at}.name`);
			if (rung.grants?.credits !== undefined) {
				requirePositiveInt(rung.grants.credits, `${at}.grants.credits`);
			}
		});
	}

	if (hasCredits) {
		const c = cfg.credits;
		if (!c) panic("bot/payments: credits config disappeared mid-validation");
		requirePolyglotCovers(c.unit, locales, "credits.unit");
		c.packs.forEach((pack, i) => {
			const at = `credits.packs[${i}]`;
			requirePositiveInt(pack.xtr, `${at}.xtr`);
			requirePositiveInt(pack.grants?.credits, `${at}.grants.credits`);
			if (pack.name) {
				requirePolyglotCovers(pack.name, locales, `${at}.name`);
			}
		});
	}

	if (hasPerks && cfg.perks) {
		for (const [key, perk] of Object.entries(cfg.perks)) {
			const at = `perks.${key}`;
			if (!/^[a-z][a-z0-9_]*$/i.test(key)) {
				panic(
					`bot/payments: perk key "${key}" must match /^[a-z][a-z0-9_]*$/i (used in ` +
						`payload encoding, must be safe)`,
				);
			}
			requirePositiveInt(perk.xtr, `${at}.xtr`);
			requirePolyglotCovers(perk.name, locales, `${at}.name`);
		}
	}

	return locales;
};

// ─── catalog build ─────────────────────────────────────────────────

/**
 * Materialize the validated config into the runtime catalog. Assumes
 * `validateConfig(cfg)` has already been called and passed.
 */
export const buildCatalog = (
	cfg: BotPaymentsConfig<string>,
): ProductCatalog => {
	const vip: VipRungResolved[] = (cfg.vip ?? []).map((rung, i) => ({
		id: `vip.${i + 1}` as `vip.${number}`,
		rank: i + 1,
		xtr: rung.xtr,
		periodSeconds: SUBSCRIPTION_PERIOD_SECONDS[rung.period],
		name: rung.name,
		creditsGranted: rung.grants?.credits ?? 0,
	}));

	const creditsPacks: CreditsPackResolved[] = (cfg.credits?.packs ?? []).map(
		(pack, i) => ({
			id: `credits.${i + 1}` as `credits.${number}`,
			xtr: pack.xtr,
			creditsGranted: pack.grants.credits,
			name: pack.name,
		}),
	);

	const perks: PerkResolved[] = Object.entries(cfg.perks ?? {}).map(
		([key, perk]) => ({
			id: `perks.${key}` as `perks.${string}`,
			key,
			xtr: perk.xtr,
			name: perk.name,
		}),
	);

	const byKey = new Map<
		string,
		VipRungResolved | CreditsPackResolved | PerkResolved
	>();
	for (const r of vip) byKey.set(r.id, r);
	for (const p of creditsPacks) byKey.set(p.id, p);
	for (const p of perks) byKey.set(p.id, p);

	return {
		vip,
		creditsUnit: cfg.credits?.unit,
		creditsPacks,
		perks,
		byKey,
	};
};
