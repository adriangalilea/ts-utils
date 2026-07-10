/**
 * `createBot` — one bot file from ideation to production.
 *
 * The composer owns the WIRING that used to be documented foot-guns: it
 * constructs the storage + session pair ONCE and threads it into every
 * feature (menu, language, access, payments), so "must be the SAME instance
 * you passed to session()" is unrepresentable instead of a doc warning.
 *
 * The same file runs in every stage — storage and transport are environment
 * decisions, never code shape:
 *
 *   ideation     BOT_TOKEN=… tsx bot.ts                 memory session, long-poll
 *   experiment   BOT_PERSIST=./bot.sqlite tsx bot.ts    sqlite session, long-poll
 *   prod worker  wrangler deploy (D1 binding `DB`)      D1 session, webhook (bot/worker)
 *   prod server  systemd/launchd unit running poll()    sqlite/redis, long-poll
 *
 * @example
 * const app = createBot({
 *   language: { supported: ["en", "es"] as const, default: "en" },
 *   menu: { adminContact: "@you", items: [...] },
 *   handlers: (bot) => bot.command("start", (ctx) => ctx.say({ en: "hi", es: "hola" })),
 * })
 * export default app                      // Worker: webhook + /setup + /pause + deploy DMs
 * if (app.isMain(import.meta)) app.poll() // Node: `tsx bot.ts` long-polls
 *
 * Worker-safe by construction: the Node-only conveniences (sqlite/redis
 * adapters) load lazily on the poll path only; `bot/kit` stays out of the
 * graph entirely (wrap `app.poll` with `gracefulStart` yourself if you want
 * signal-handled start/stop DMs on a server).
 */

import { inMemoryStorage, type Storage } from "@gramio/storage";
import { Bot } from "gramio";
import { runtime } from "../runtime.js";
import { createLogger } from "../universal/log.js";
import { type AccessControlOptions, accessControl } from "./access-control.js";
import { type Admins, adminContext } from "./admin.js";
import { type LanguageOptions, language } from "./language.js";
import {
	type BotMenuOptions,
	botMenu,
	type MenuItem,
	type PersonalDataOptions,
} from "./menu.js";
import { type BotPaymentsConfig, botPayments } from "./payments/index.js";
import { botSession } from "./session.js";
import { type D1Like, d1Storage } from "./storage-d1.js";
import { type BotWorkerRuntime, botWorkerFetch } from "./worker.js";

const log = createLogger("bot");

type EnvLike = Record<string, unknown>;

export type CreateBotOptions<
	S extends Record<string, unknown> = Record<string, unknown>,
> = {
	/** Display name for startup logs. Default: the bot's username once known. */
	name?: string;
	/**
	 * Bot token. Default: the `BOT_TOKEN` environment value (process env on
	 * Node, the Worker env in workerd). Missing token throws at build — a bot
	 * with no token must scream, not idle.
	 */
	token?: string | ((env: EnvLike) => string | undefined);
	/**
	 * Session storage OVERRIDE — an instance, or `(env) => Storage` when the
	 * choice depends on the environment (e.g. a D1 binding NOT named `DB`).
	 * Default resolution (the lifecycle story): workerd → the `DB` D1 binding;
	 * Node → `BOT_PERSIST` (a path = sqlite via `@gramio/storage-sqlite`,
	 * `redis://…` = `@gramio/storage-redis`), else in-memory (ephemeral,
	 * announced at startup).
	 */
	storage?: Storage | ((env: EnvLike) => Storage | Promise<Storage>);
	/** Initial session record for a new user. Types `S` through to `handlers`' session accessor. */
	initial?: () => S;
	/** Admin user ids (static or a LIVE resolver) — enables access/payments admin flows + lifecycle DMs. */
	admins?: Admins;
	/** UI language feature (`ctx.lang`/`ctx.say`, read-time stored→hint→default). */
	language?: Omit<LanguageOptions<readonly string[]>, "session">;
	/**
	 * /settings menu. `personalData` is auto-wired to the composer's storage —
	 * pass `personalData: { onForget }` to also wipe your own tables, or
	 * `personalData: false` to drop Forget/Export entirely. When `language` is
	 * configured its picker item is appended automatically (opt out with
	 * `languagePicker: false`).
	 */
	menu?: Omit<BotMenuOptions, "personalData"> & {
		personalData?: Pick<PersonalDataOptions, "onForget"> | false;
		languagePicker?: boolean;
	};
	/** Gate the bot to admins + approved users (requires `admins`). */
	access?: Omit<AccessControlOptions, "session" | "storage">;
	/** Telegram Stars monetization (requires `admins` — the refund approver). */
	payments?: Omit<BotPaymentsConfig<string>, "session" | "storage">;
	/**
	 * Your commands/handlers — runs LAST, after every feature is wired.
	 * `session(ctx)` is the TYPED accessor for your `S` fields (gramio derive
	 * types don't flow into generic handlers; this beats casting per call site).
	 */
	handlers?: (bot: Bot, api: { session: (ctx: unknown) => S }) => void;
	/** Extra options forwarded to `bot/worker` in the Worker cap (routes, statusExtra, mode…). */
	worker?: (env: EnvLike) => Partial<BotWorkerRuntime>;
};

export type BotApp<
	S extends Record<string, unknown> = Record<string, unknown>,
> = {
	/** Build (memoized) — exposed for tests and custom runtimes. */
	build(
		env?: EnvLike,
	): Promise<{ bot: Bot; storage: Storage; flush?: () => Promise<void> }>;
	/** Typed accessor for your session fields (`S`), usable anywhere a ctx exists. */
	session(ctx: unknown): S;
	/** Long-poll (Node/Bun/Deno). The ideation loop AND a legitimate prod mode on your own hardware. */
	poll(): Promise<void>;
	/** True when this module is the process entrypoint (`tsx bot.ts`). Always false on workerd. */
	isMain(meta: ImportMeta): boolean;
	/** The Worker fetch handler — `export default app` is a complete workerd bot. */
	fetch(
		request: Request,
		env: EnvLike,
		ctx: { waitUntil(p: Promise<unknown>): void },
	): Promise<Response>;
};

// Optional Node-only peers, loaded lazily on the poll path. The specifier goes
// through a variable so TS doesn't demand types for an optional dependency.
async function importPeer(name: string, why: string): Promise<unknown> {
	try {
		const specifier: string = name;
		return await import(specifier);
	} catch {
		throw new Error(`createBot: install ${name} for ${why}`);
	}
}

const idsOf = (v: number | readonly number[]): number[] =>
	(typeof v === "number" ? [v] : [...v]).filter(
		(n) => Number.isFinite(n) && n > 0,
	);

export function createBot<
	S extends Record<string, unknown> = Record<string, unknown>,
>(opts: CreateBotOptions<S> = {}): BotApp<S> {
	let built: Promise<{
		bot: Bot;
		storage: Storage;
		flush?: () => Promise<void>;
	}> | null = null;

	const resolveToken = (env: EnvLike): string => {
		const token =
			typeof opts.token === "string"
				? opts.token
				: (opts.token?.(env) ?? (env.BOT_TOKEN as string | undefined));
		if (!token)
			throw new Error("createBot: no token — set BOT_TOKEN or pass `token`");
		return token;
	};

	const resolveStorage = async (
		env: EnvLike,
	): Promise<{
		storage: Storage;
		kind: string;
		flush?: () => Promise<void>;
	}> => {
		if (opts.storage) {
			if (typeof opts.storage === "function") {
				return {
					storage: await opts.storage(env),
					kind: "custom (env-resolved)",
				};
			}
			return { storage: opts.storage, kind: "custom" };
		}
		const db = env.DB as D1Like | undefined;
		if (db && typeof db === "object" && "prepare" in db) {
			const storage = d1Storage({ db });
			return { storage, kind: "d1", flush: storage.flush };
		}
		const persist = env.BOT_PERSIST as string | undefined;
		if (persist?.startsWith("redis://") || persist?.startsWith("rediss://")) {
			const mod = await importPeer(
				"@gramio/storage-redis",
				"BOT_PERSIST=redis://…",
			);
			const factory = (mod as { redisStorage?: (url: string) => Storage })
				.redisStorage;
			if (!factory)
				throw new Error(
					"createBot: @gramio/storage-redis has no redisStorage export",
				);
			return { storage: factory(persist), kind: "redis" };
		}
		if (persist) {
			const mod = (await importPeer(
				"@gramio/storage-sqlite",
				"a BOT_PERSIST path",
			)) as {
				sqliteStorage?: (path: string) => Storage;
				default?: (path: string) => Storage;
			};
			const factory = mod.sqliteStorage ?? mod.default;
			if (!factory)
				throw new Error(
					"createBot: @gramio/storage-sqlite has no storage export",
				);
			return { storage: factory(persist), kind: `sqlite ${persist}` };
		}
		return {
			storage: inMemoryStorage(),
			kind: "memory (ephemeral — set BOT_PERSIST to keep state)",
		};
	};

	const build = (env?: EnvLike) => {
		built ??= (async () => {
			const e = env ?? (runtime.isNode ? (process.env as EnvLike) : {});
			const bot = new Bot(resolveToken(e));
			const { storage, kind, flush } = await resolveStorage(e);
			log.info(`session: ${kind}`);

			// ONE session, threaded everywhere — the composer's whole job.
			const session = botSession({
				storage,
				initial: (opts.initial ?? (() => ({}))) as () => Record<
					string,
					unknown
				>,
			});
			bot.extend(session);

			const lang = opts.language
				? language({ ...opts.language, session })
				: null;
			if (lang) bot.extend(lang.plugin);

			if (opts.admins) bot.extend(adminContext(opts.admins));
			if (opts.access) {
				if (!opts.admins)
					throw new Error("createBot: `access` needs `admins` (the approver)");
				bot.extend(accessControl({ ...opts.access, session, storage }));
			}

			const payments = opts.payments
				? botPayments({ ...opts.payments, session, storage } as never)
				: null;
			if (payments) {
				if (!opts.admins)
					throw new Error(
						"createBot: `payments` needs `admins` (the refund approver)",
					);
				bot.extend(payments.plugin);
			}

			if (opts.menu) {
				const { personalData, languagePicker, items, ...menuOpts } = opts.menu;
				const composed: MenuItem[] = [...(items ?? [])];
				if (lang && languagePicker !== false) composed.push(lang.menuItem);
				if (payments) composed.push(payments.menuItem);
				bot.extend(
					botMenu({
						...menuOpts,
						items: composed,
						...(personalData === false
							? {}
							: {
									personalData: { storage, onForget: personalData?.onForget },
								}),
					}).plugin,
				);
			}

			opts.handlers?.(bot, { session: sessionOf });

			// Narrate the composition — automation you can watch is not magic.
			const features = [
				opts.language ? `language(${opts.language.supported.join(",")})` : null,
				opts.menu ? `menu(/${opts.menu.command ?? "settings"})` : null,
				opts.admins ? "admins" : null,
				opts.access ? "access" : null,
				opts.payments
					? `payments(${[
							opts.payments.vip?.length
								? `vip×${opts.payments.vip.length}`
								: null,
							opts.payments.credits ? "credits" : null,
							opts.payments.perks ? "perks" : null,
						]
							.filter(Boolean)
							.join("+")})`
					: null,
			].filter(Boolean);
			if (features.length > 0) log.info(`features: ${features.join(" · ")}`);

			return { bot, storage, flush };
		})();
		return built;
	};

	// The typed session accessor: gramio derive types don't flow into generic
	// handlers, so this ONE cast (behind a name) replaces a cast per call site.
	const sessionOf = (ctx: unknown): S => {
		const s = (ctx as { session?: S }).session;
		if (!s)
			throw new Error("createBot: no session on this ctx (service update?)");
		return s;
	};

	const adminIds = (): (() => Promise<readonly number[]>) | undefined => {
		const a = opts.admins;
		if (a === undefined) return undefined;
		return typeof a === "function"
			? async () => idsOf(await a())
			: async () => idsOf(a);
	};

	const workerFetch = botWorkerFetch<EnvLike>(async (env) => {
		const { bot, flush } = await build(env);
		return {
			bot: bot as never,
			webhookSecret: env.WEBHOOK_SECRET as string | undefined,
			operatorSecret: env.OPERATOR_SECRET as string | undefined,
			mode: (env.MODE as string | undefined) ?? opts.name,
			adminIds: adminIds(),
			flush,
			...opts.worker?.(env),
		};
	});

	return {
		build,
		session: sessionOf,
		async poll() {
			const { bot } = await build();
			await bot.start();
			log.ready(`${opts.name ?? "bot"} polling as @${bot.info?.username}`);
		},
		isMain(meta: ImportMeta): boolean {
			const main = (meta as { main?: boolean }).main;
			if (main !== undefined) return main;
			if (!runtime.isNode) return false;
			// Fallback for runtimes without import.meta.main: entrypoint filename match.
			const argv1 = process.argv[1];
			if (!argv1) return false;
			const tail = argv1.split("/").pop();
			return !!tail && meta.url.endsWith(`/${tail}`);
		},
		fetch: workerFetch,
	};
}
