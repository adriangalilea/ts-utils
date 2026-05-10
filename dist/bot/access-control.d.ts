/**
 * Access control for personal GramIO bots — a one-stop guard +
 * approve/deny + revocable allow-list with an inline admin menu.
 *
 *                stranger DMs your bot
 *                       │
 *                       ▼
 *      ┌──── plugin gate (this file) ────────────────────┐
 *      │  ctx.from.id  ∈  admin / defaults / approved?   │
 *      │     yes → next()                                │
 *      │     no  → drop + notify admin (rate-limited)    │
 *      └─────────────────────────────────────────────────┘
 *                       │
 *           admin gets DM with [✅ Aprobar] [❌ Denegar]
 *                       │
 *                  admin taps
 *                       │
 *      stranger's session updated  ·  stranger gets DM
 *
 * **Storage layout.** Per-user state lives in its own key, written
 * through `@gramio/session` so the gate read on the hot path costs
 * nothing extra (session is loaded for the user already). A single
 * tiny index key keeps track of who's pending / approved / denied so
 * the `/access` admin menu can list without scanning the whole DB.
 *
 *     storage:
 *       access:<userId>        → AccessRecord  (the user's session)
 *       ac:index               → { pending, approved, denied }
 *
 * **Cross-user mutations.** When you tap `[✅ Aprobar]` on Pepe's
 * notification, ctx is *yours* (the admin), so `ctx.access` is your
 * own record. To mutate Pepe's record we hit the storage at the same
 * key format we registered the session with (`access:<id>`) and
 * update the index. This isn't a hack — it's our own module
 * coordinating with itself.
 *
 * **Composes with `adminContext`** (kit.ts) — that plugin must be
 * extended first or `bot.start()` throws. Inside this plugin,
 * `ctx.adminId` and `ctx.isAdmin` are typed.
 *
 * Peer deps: `gramio`, `@gramio/storage`, `@gramio/session`.
 *
 * @example
 * import { Bot } from 'gramio'
 * import { redisStorage } from '@gramio/storage-redis'
 * import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
 * import { accessControl } from '@adriangalilea/utils/bot/access-control'
 *
 * const storage = redisStorage()
 *
 * const bot = new Bot(process.env.BOT_TOKEN!)
 *   .extend(adminContext({ adminId: 190202471 }))
 *   .extend(accessControl({ storage, defaults: [1158734055] }))
 *   .command('start', (ctx) => ctx.send(`hola, source=${ctx.access.source}`))
 *
 * await gracefulStart(bot)
 */
import { type AnyBot, type DeriveDefinitions, Plugin } from 'gramio';
import { type Storage } from '@gramio/storage';
export type AccessStatus = 'unknown' | 'pending' | 'approved' | 'denied';
export type AccessUser = {
    id: number;
    firstName?: string;
    lastName?: string;
    username?: string;
};
/**
 * The shape persisted per-user via session at `access:<userId>`.
 * `unknown` is the initial state (session never seen this user).
 */
export type AccessRecord = {
    status: AccessStatus;
    user?: AccessUser;
    /** Chat to DM the user back. For private chats this equals user.id. */
    chatId?: number;
    requestedAt?: number;
    approvedAt?: number;
    approvedBy?: number;
    deniedAt?: number;
    deniedBy?: number;
    /** First message text from the request (truncated). */
    firstMessage?: string;
    lastActivityAt?: number;
    messageCount?: number;
    /** Counts attempts after the initial request — used by the throttle. */
    rejectedAttempts?: number;
    lastNotifiedAt?: number;
};
export type AccessIndex = {
    pending: number[];
    approved: number[];
    denied: number[];
};
export type AccessSource = 'admin' | 'default' | 'store';
/**
 * What handlers downstream see on `ctx.access`. A discriminated union —
 * use the `allowed` field to narrow.
 */
export type AccessInfo = {
    allowed: true;
    source: AccessSource;
    /** The persisted record, when source is 'store'. */
    record?: AccessRecord;
} | {
    allowed: false;
    reason: 'denied' | 'pending' | 'unknown' | 'no-sender';
};
export type AccessControlOptions = {
    /** Persistence. Default `inMemoryStorage()` (data lost on restart — warns once). */
    storage?: Storage;
    /** Always-allowed user ids, hardcoded. Bypass the entire flow. */
    defaults?: ReadonlyArray<number>;
    /** Reply sent to denied users on first attempt. `false` to silence. */
    denyMessage?: string | false;
    /** Min ms between repeat admin notifications for the same user. Default 6h. */
    notifyThrottleMs?: number;
    /** Callbacks for your own logging / metrics. */
    onAccessRequest?: (info: {
        user: AccessUser;
        firstMessage?: string;
    }) => void;
    onApprove?: (info: {
        userId: number;
        approvedBy: number;
    }) => void;
    onDeny?: (info: {
        userId: number;
        deniedBy: number;
    }) => void;
};
type AdminDerives = {
    adminId: number;
    isAdmin: boolean;
};
type AccessSessionDerives = {
    _accessSession: AccessRecord;
};
type AccessDerives = {
    access: AccessInfo;
};
export declare const accessControl: (opts?: AccessControlOptions) => Plugin<{}, DeriveDefinitions & {
    global: AdminDerives & AccessSessionDerives & AccessDerives;
} & {
    message: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    channel_post: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    inline_query: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    chosen_inline_result: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    callback_query: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    shipping_query: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    pre_checkout_query: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    poll_answer: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    chat_join_request: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    new_chat_members: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    new_chat_title: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    new_chat_photo: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    delete_chat_photo: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    group_chat_created: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    message_auto_delete_timer_changed: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    migrate_to_chat_id: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    migrate_from_chat_id: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    pinned_message: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    invoice: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    successful_payment: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    chat_shared: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    proximity_alert_triggered: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    video_chat_scheduled: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    video_chat_started: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    video_chat_ended: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    video_chat_participants_invited: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    web_app_data: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    location: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
    passport_data: {
        _accessSession: AccessRecord & {
            $clear: () => Promise<void>;
        };
    };
} & {
    global: {
        access: {
            allowed: false;
            reason: "no-sender";
            source?: undefined;
            record?: undefined;
        };
    } | {
        access: {
            allowed: true;
            source: "admin";
            reason?: undefined;
            record?: undefined;
        };
    } | {
        access: {
            allowed: true;
            source: "default";
            reason?: undefined;
            record?: undefined;
        };
    } | {
        access: {
            allowed: true;
            source: "store";
            record: AccessRecord;
            reason?: undefined;
        };
    } | {
        access: {
            allowed: false;
            reason: "unknown" | "pending" | "denied";
            source?: undefined;
            record?: undefined;
        };
    };
}, {}>;
/**
 * Inject a synthetic access request — for tests/demos when you can't
 * easily spin up a second Telegram account. Writes a `pending` record
 * to storage at the same key the plugin's session would, updates the
 * index, then DMs the admin with the real
 * `[✅ Aprobar][❌ Denegar]` keyboard. Tapping those buttons exercises
 * the real callback handlers end-to-end.
 *
 * Pass the SAME `storage` instance you passed to `accessControl({ storage })`.
 */
export declare const simulateAccessRequest: (bot: AnyBot, storage: Storage, adminId: number, fakeUser: AccessUser, message?: string) => Promise<void>;
export {};
//# sourceMappingURL=access-control.d.ts.map