import { Plugin } from 'gramio';
import { kev } from '../platform/kev.js';
export const gracefulStart = async (bot, opts = {}) => {
    const log = opts.log === false ? () => { } : (opts.log ?? ((m) => console.log(m)));
    const forceMs = opts.forceExitAfterMs ?? 10_000;
    let stopping = false;
    const stop = async (signal) => {
        if (stopping)
            return;
        stopping = true;
        log(`[bot] ${signal} received, shutting down…`);
        const force = setTimeout(() => {
            console.error(`[bot] forced exit after ${forceMs}ms`);
            process.exit(1);
        }, forceMs);
        force.unref?.();
        try {
            await bot.stop();
            await opts.onShutdown?.();
            log('[bot] shutdown clean');
        }
        catch (e) {
            console.error('[bot] shutdown error', e);
        }
        finally {
            clearTimeout(force);
            process.exit(opts.exitCode ?? 0);
        }
    };
    process.on('SIGINT', () => void stop('SIGINT'));
    process.on('SIGTERM', () => void stop('SIGTERM'));
    await bot.start();
};
export const adminContext = (opts = {}) => {
    // KEV resolves: process.env → .env (project + monorepo, auto-discovered) → fallback.
    // Cached after first read. `kev.int` panics on non-int strings, so a malformed
    // env var screams immediately rather than producing NaN downstream.
    const adminId = kev.int('TELEGRAM_ADMIN_ID', opts.adminId ?? 0);
    if (!adminId) {
        throw new Error('adminContext: TELEGRAM_ADMIN_ID not set and no adminId fallback. ' +
            'Get your Telegram id from @UserIDentifyBot.');
    }
    return new Plugin('@adriangalilea/utils/bot/admin')
        .decorate({ adminId })
        .derive((ctx) => ({
        // `senderId` is provided by gramio's SenderMixin. It's `undefined` on
        // service-style events without an actor; the strict equality below
        // gives `false` in that case, which is the right answer.
        isAdmin: 'senderId' in ctx && ctx.senderId === adminId,
    }));
};
//# sourceMappingURL=kit.js.map