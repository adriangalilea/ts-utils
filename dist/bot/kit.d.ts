/**
 * Foundational helpers every bot wants. Two things:
 *
 *   `gracefulStart(bot, opts?)` — wires SIGINT/SIGTERM to bot.stop(),
 *     runs an optional shutdown hook, force-kills if it hangs.
 *
 *   `adminContext({ adminId? })` — reads admin Telegram id from KEV
 *     (`TELEGRAM_ADMIN_ID`) with optional hardcoded fallback. Decorates
 *     every context with `ctx.adminId` (number) and `ctx.isAdmin`
 *     (boolean). Throws at startup if neither source provides an id.
 *
 * Peer deps: `gramio`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(adminContext({ adminId: 190202471 }))   // KEV wins, 190… is fallback
 *   .command('whoami', (ctx) => ctx.send(`admin? ${ctx.isAdmin}`))
 *
 * await gracefulStart(bot, { onShutdown: () => db.end() })
 */
import type { AnyBot } from 'gramio';
import { Plugin } from 'gramio';
export type GracefulStartOptions = {
    /** Runs after `bot.stop()` resolves, before `process.exit`. Close DBs, flush logs. */
    onShutdown?: () => Promise<void> | void;
    /** Process exit code on graceful shutdown. Default 0. */
    exitCode?: number;
    /** Hard-kill after this many ms if shutdown hangs. Default 10000. */
    forceExitAfterMs?: number;
    /** Logger. Default `console.log`. Set `false` to silence. */
    log?: ((msg: string) => void) | false;
};
export declare const gracefulStart: (bot: AnyBot, opts?: GracefulStartOptions) => Promise<void>;
export type AdminContextOptions = {
    /** Hardcoded fallback used when `KEV.TELEGRAM_ADMIN_ID` is unset. */
    adminId?: number;
};
export declare const adminContext: (opts?: AdminContextOptions) => Plugin<{}, import("gramio").DeriveDefinitions & {
    global: {
        adminId: number;
    };
} & {
    global: {
        isAdmin: boolean;
    };
}, {}>;
//# sourceMappingURL=kit.d.ts.map