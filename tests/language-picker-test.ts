// bot/language picker-surface contract tests: labels (flag + autonym), the generic
// picker item (2-up, primary on active, policy in closures), and the raw-keyboard
// rows. Run: pnpm test:language-picker
import assert from "node:assert/strict";
import { InlineKeyboard } from "gramio";
import {
	addLanguageRows,
	autonym,
	flagFor,
	languageLabel,
	languagePickerItem,
} from "../src/bot/language.js";
import type { MenuCtx } from "../src/bot/menu.js";

let pass = 0;
const ok = (name: string, fn: () => void | Promise<void>) =>
	Promise.resolve(fn()).then(() => {
		pass++;
		console.log("  PASS", name);
	});

await ok("labels: flag + autonym, regioned tags take the region's flag", () => {
	assert.equal(languageLabel("es"), "🇪🇸 Español");
	assert.equal(languageLabel("hi"), "🇮🇳 हिन्दी");
	assert.equal(flagFor("pt-BR"), "🇧🇷");
	assert.equal(flagFor("xx"), "🌐");
	assert.equal(autonym("ja"), "日本語");
});

await ok("picker item: 2-up rows, active code wears primary, pick gets the code", async () => {
	const picked: string[] = [];
	const item = languagePickerItem({
		label: "🌐 Language",
		codes: ["en", "es", "fr"],
		isActive: (_ctx, code) => code === "es",
		pick: (_ctx, code) => {
			picked.push(code);
			return `✓ ${code}`;
		},
	});
	assert.equal(item.id, "lang");
	const entries = (item as { submenu: Array<Record<string, unknown>> }).submenu;
	assert.deepEqual(
		entries.map((e) => [e.id, e.keepRow]),
		[
			["en", true],
			["es", false],
			["fr", false],
		],
	);
	const ctx = {} as MenuCtx;
	const styles = await Promise.all(
		entries.map((e) => (e.style as (c: MenuCtx) => Promise<string | undefined>)(ctx)),
	);
	assert.deepEqual(styles, [undefined, "primary", undefined]);
	assert.equal(await (entries[1].action as (c: MenuCtx) => unknown)(ctx), "✓ es");
	assert.deepEqual(picked, ["es"]);
});

await ok("addLanguageRows: appends 2-up after lead rows, active styled, trailing rows chain", () => {
	const kb = new InlineKeyboard().text("lead", "lead|");
	addLanguageRows(kb, {
		codes: ["en", "es", "fr"],
		pack: (code) => `xob|${code}`,
		active: "fr",
	}).row();
	kb.text("✓ Got it", "xgw|");
	const rows = kb.toJSON().inline_keyboard as Array<Array<Record<string, unknown>>>;
	assert.deepEqual(
		rows.map((r) => r.map((b) => b.text)),
		[["lead"], ["🇬🇧 English", "🇪🇸 Español"], ["🇫🇷 Français"], ["✓ Got it"]],
	);
	assert.equal(rows[2][0].style, "primary");
	assert.equal(rows[1][0].callback_data, "xob|en");
});

console.log(`\n${pass} passed`);
