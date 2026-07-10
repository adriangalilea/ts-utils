# `bot/payments` — Telegram Stars monetization

Plug-and-forget monetization for personal GramIO bots. Stars-only (v1), three
orthogonal axes (VIP tiers, credits, perks), composes with `botMenu` /
`botSession` / `bot/language` / `adminContext`. The plugin owns waiver
consent, `/paysupport`, refunds, idempotency, expiry — bot author writes a
config and ~3 call sites.

This file is the **source of truth** for *why* every shape exists. The
implementation files reference back here. Future-me reads this before
re-deriving from scratch.

---

## Public DX

```ts
import { Bot } from 'gramio'
import { redisStorage } from '@gramio/storage-redis'
import {
  adminContext,
  botSession,
  gracefulStart,
} from '@adriangalilea/utils/bot/kit'
import { language } from '@adriangalilea/utils/bot/language'
import { botMenu } from '@adriangalilea/utils/bot/menu'
import { botPayments } from '@adriangalilea/utils/bot/payments'

const storage = redisStorage()
const userSession = botSession({ storage, key: 'session', initial: () => ({}) })

const lang = language({
  session: userSession,
  supported: ['en', 'es'] as const,
  default: 'en',
})

const payments = botPayments({
  session: userSession,
  storage,
  paysupport: '@adriangalilea',        // ToS §6.5 — mandatory
  legal: {                              // mandatory: drives factura + waiver context
    sellerName: 'Adrian Galilea',
    nif: 'X1234567Y',
    termsUrl:   'https://…/terms',
    privacyUrl: 'https://…/privacy',
  },
  waiver: {                             // Art. 103(m) TRLGDCU — mandatory if any product
    version: '2026-05-11',
    text: {
      en: 'I expressly request immediate delivery of the digital content. ' +
          'I understand that under Art. 103(m) TRLGDCU I lose the 14-day ' +
          'right of withdrawal once execution begins.',
      es: 'Solicito expresamente el suministro inmediato del contenido digital. ' +
          'Entiendo que conforme al art. 103.m) del TRLGDCU pierdo el derecho ' +
          'de desistimiento una vez iniciada la ejecución.',
    },
  },

  // ── three axes — declare only what you use ──
  // VIP is a *positional* ladder. Single rung = one-element array.
  // Adding a rung later = insert into the array; storage migration is
  // a trivial index rewrite. Names are display-only Polyglot.
  vip: [
    { xtr: 500,  period: '30d', name: { en: 'VIP',     es: 'VIP'     }, grants: { credits: 1000  } },
    { xtr: 2000, period: '30d', name: { en: 'VIP Max', es: 'VIP Max' }, grants: { credits: 10000 } },
  ],
  credits: {
    unit: { en: 'message', es: 'mensaje' },
    packs: [
      { xtr: 100, grants: { credits: 100 } },
      { xtr: 400, grants: { credits: 500 } },
    ],
  },
  perks: {
    voice_mode: { xtr: 1500, name: { en: 'Voice mode', es: 'Modo voz' } },
  },
})

const menu = botMenu({
  command: 'settings',
  description: 'Open settings',
  adminContact: '@adriangalilea',
  personalData: { storage },
  items: [lang.menuItem, payments.menuItem],
})

const bot = new Bot(process.env.BOT_TOKEN!)
  .extend(adminContext(123456789))
  .extend(userSession)
  .extend(lang.plugin)
  .extend(payments.plugin)
  .extend(menu.plugin)
  .on('message', async (ctx) => {
    if (!await ctx.payments.require('vip')) return
    if (!await ctx.payments.credits.tryConsume(1)) {
      return ctx.payments.invoice('credits.0')
    }
    /* … your feature … */
  })

await gracefulStart(bot)
```

### Surface (the *whole* DX)

| Surface | Purpose |
|---|---|
| `ctx.payments.atLeast('vip')` | Tier check, any rung. Always typechecks. |
| `ctx.payments.atLeast('vip.2')` | Rung-2-or-higher. TS-errors when only 1 rung declared. |
| `ctx.payments.tier()` | `'free' \| 'vip.1' \| 'vip.2' \| …` (typed against config). |
| `ctx.payments.tier.level()` | `0 \| 1 \| 2 \| …` — integer rank. |
| `ctx.payments.tier.label()` | Resolved Polyglot label for current rung, `undefined` on free. (Named `label` not `name` because `Function.prototype.name` is read-only in strict mode.) |
| `ctx.payments.credits.balance()` | Number. |
| `ctx.payments.credits.consume(n)` | Atomic decrement; throws `InsufficientCredits` if `< n`. |
| `ctx.payments.credits.tryConsume(n)` | Same, returns boolean. |
| `ctx.payments.has(perkId)` | Perk ownership boolean. |
| `await ctx.payments.require('vip', { feature? })` | Gate. Returns boolean. On `false` sends localized upgrade prompt with one button → menu. |
| `await ctx.payments.invoice(productKey)` | Direct purchase. Threads waiver consent inline. |
| `payments.menuItem` | Drop-in for `botMenu`. Adaptive label/style/submenu. |
| `payments.onFulfilled(productKey, handler)` | Fire-and-forget hook after a charge is applied. Sync handler signature; plugin always answers. |
| `payments.onRefunded(productKey, handler)` | The fulfillment mirror: fires after an admin-approved refund succeeds, with a `RefundEvent` (productKey/userId/chargeId/xtr/refundedAt) — so a revenue ledger reverses the row it wrote. `'*'` catch-all works here too. |
| `payments.payouts.record({ ton, eurAtReceipt, batchId? })` | Manual Fragment payout entry. |
| `payments.payouts.export({ from, to })` | CSV/JSON for the gestor — joins charges by `receivedAt` window. |

### Tier ids — positional, name-free

The `vip` ladder is an ordered array. The id is `'vip.N'` where N is the
**1-indexed** array position (so what the user sees as "Level 1" matches
the id literally). The bare id `'vip'` is the synonym for "any rung in
this namespace":

```ts
ctx.payments.atLeast('vip')       // any rung
ctx.payments.atLeast('vip.2')     // rung 2 or higher; TS-error if only 1 declared
ctx.payments.tier()               // → 'free' | 'vip.1' | 'vip.2'
```

Insert a new rung at position 2? Storage migration is `i → i+1` for
charges whose `rung >= 2`; no string-id churn anywhere. Renaming "VIP+" to
"VIP Pro" is a Polyglot edit; checks and storage are untouched.

### Three patterns, composed

- **One-time** — a `perks` entry. Idempotent set-if-absent on
  `session.pay.perks[id]`.
- **Subscription** — `vip` ladder, monotonic inheritance. Telegram fires
  fresh `successful_payment` on every renewal; we bump `expiresAt`. Cancel
  via `editUserStarSubscription`; access lasts until period end.
- **Pay-per-use** — `credits` packs (one-shot top-up). Subscription rungs
  *also* grant credits on each renewal via `grants.credits`. Consumption
  is just `credits.consume(n)` in your feature code.

### Tier change semantics

- **Upgrade mid-period** (vip.1 → vip.2): user buys vip.2; plugin
  auto-cancels vip.1 renewal via `editUserStarSubscription({ is_canceled: true })`.
  Effective tier is vip.2 immediately (rank-based); vip.1 expires silently
  at its period end. No proration — Telegram exposes none.
- **Downgrade**: user toggles cancel on vip.2; on expiry they fall to
  `free`. No auto-queue of vip.1 (no Telegram primitive); they re-buy from
  the menu next time `require('vip')` fires.
- **Sidegrade**: impossible by construction — tiers are an ordered enum.

---

## Compliance memo — Spain autónomo, May 2026

### §1 — Telegram Stars: who is the seller of record for EU VAT?

**Reading the canonical Bot Developer ToS** (telegram.org/tos/bot-developer,
fetched May 2026):

- §6.2: "all transactions pertaining to digital goods and services must
  be executed exclusively through the exchange of Telegram Stars."
- §6.2.2: "Telegram Stars displayed in your balance do not constitute
  your property … Telegram is not a financial institution and does not
  act as a custodian of your funds."
- §6.2.4: "Developers can receive an equivalent of 0.013 USD worth of
  rewards for each Telegram Star." Rewards are issued **by Fragment**,
  via the TON blockchain.
- §6.4 (Taxes): "You are solely responsible for all taxes and fees
  associated with any income you receive."
- User-facing Stars ToS (telegram.org/tos/stars): "Telegram uses
  third-party payment processors to facilitate purchases of Stars …
  Telegram does not process these transactions."

**Resulting structure:**

```
User (EU) ──IAP──▶ Apple/Google (or PremiumBot) ──▶ Telegram (issues Stars)
                                                          │
User ──spends Stars──▶ Your bot (XTR on Telegram's books) │
                                                          │
Fragment (offshore) ──TON payout──▶ Your TON wallet ◀─────┘
You ──convert TON to EUR──▶ Bank ──▶ AEAT
```

- **SOR for the user's purchase of Stars**: Apple/Google (IAP) or
  Telegram's PSP (web). They charge the VAT; user's receipt is from them.
- **You**: receive *rewards* from Fragment Corp (non-EU intermediary).
  This is **not** B2C digital services revenue subject to per-country EU
  VAT. Best fit: ingreso de actividad económica (IRPF) + B2B export of
  services to a non-EU recipient — **no sujeto IVA** per LIVA Art. 69.
- **No OSS/IOSS registration triggered.** OSS exists for EU sellers
  charging EU consumers; you're not the party charging consumers.
- **No buyer-country-of-residence data** is needed or stored. Explicit
  non-feature.

**One caveat** to walk through with a gestor: if AEAT decides to pierce
the Fragment intermediary and treat you as the underlying digital-services
provider to EU consumers, the picture changes radically. The contractual
structure (Fragment is the legal counterparty on payout) supports the
"income from non-EU intermediary" reading, but there's no Spanish guidance
specific to Stars yet. Document the position in writing.

### §2 — BotFather fiat providers (Stripe, etc.)

ToS §6.2: "transactions for digital goods and services cannot be processed
through third-party payment providers." core.telegram.org/bots/payments
itself confirms: BotFather provider tokens are **physical goods only**.

⇒ Stripe / Tranzzo / Smart Glocal / YooKassa **are not options** for
digital products. Using them risks bot removal from iOS/Android Telegram.

⇒ For real card payments outside Stars, deep-link to a Stripe Checkout
session on your own domain (Mini App or `t.me/your_bot?start=…` → reply
web URL). Same merchant flow as any SaaS; OSS applies because *now* you
are the SOR. **Out of scope for v1** — separate sales channel, separate
ledger, separate compliance section here once it ships.

### §3 — MiCA + Crypto Pay (@CryptoBot)

MiCA in force since 30 Dec 2024; Spain's grandfathering closed end of
2025. Crypto Pay is an operationally-custodial offshore provider with no
EU CASP licence. Accepting their service flow exposes you to:

- Unlicensed-CASP risk on the provider side
- Travel Rule (EU Reg 2023/1113) gaps on transfers
- USDT-specific MiCA friction (Tether unlicensed in EU as of early 2026;
  EU exchanges restricting USDT pairs)

⇒ **Skip Crypto Pay entirely for v1.** If a TON rail is needed later,
prefer TON Connect direct-to-wallet (non-custodial; MiCA doesn't apply
to pure smart-contract interactions) over Crypto Pay's custodial flow.

### §4 — Spanish e-invoicing (Verifactu + Crea y Crece)

- **Verifactu** (RD 1007/2023, Ley Antifraude): now **1 Jul 2027** for
  autónomos. Only triggers if you use *facturación software*. If the
  bot is the system of record for sales (issues per-user facturas),
  the bot becomes a SIF and inherits Verifactu obligations (hash chain,
  QR, log de eventos, optional real-time reporting).
- **Crea y Crece** (Ley 18/2022, RD 238/2026): B2B e-invoice, phase-in
  Oct 2027 (>€8M) / Oct 2028 (rest). **B2B only** — bot users are B2C,
  not affected.

⇒ **Cleanest setup**: issue **one Spanish factura per Fragment payout**
to Fragment Corp (B2B-export, sin IVA). End-users get Telegram /
Apple / Google receipts directly; the bot issues nothing per-user. This
dodges Verifactu entirely. Confirm with gestor.

### §5 — Art. 103(m) TRLGDCU — the 14-day waiver

Spain's transposition of the Consumer Rights Directive into RDLeg
1/2007. Art. 103(m) waives the 14-day right of withdrawal for digital
content **only if** all three are present:

1. **Prior express consent** to begin execution during the withdrawal period
2. **Acknowledgment** that the user thereby loses the right of withdrawal
3. **Confirmation** of the contract on a durable medium (Art. 98.7 / 99.2)

This plugin enforces all three:

- The consent prompt is **a separate, unbundled affirmative action** —
  one inline button "✅ Consiento y comprendo". Bundling inside ToS
  acceptance voids the waiver.
- The waiver text MUST contain both points 1 (consent) and 2
  (acknowledgment of loss). The plugin doesn't validate the wording
  itself; the config supplies the Polyglot text per `legal.locale`.
- The plugin persists `{ at, version, locale }` to `session.pay.waiver`
  and snapshots it onto every `pay:charge:*` record as
  `waiverSnapshot`. The confirmation message sent to the user IS the
  durable medium (Telegram preserves it).

Bump `waiver.version` (a date string like `'2026-05-11'`) when the text
changes → forces re-consent before the next purchase. Old consents stay
attached to old charges, intact for audit.

**Subscription nuance**: AP Madrid ruling 2019-10-16 says the waiver
applies to the *initial execution* only; for ongoing periods the consumer
keeps prospective cancel rights. The plugin already implements
cancel-anytime-effective-end-of-period via `editUserStarSubscription`.

### §6 — GDPR retention & lawful basis

- **Lawful basis**: contract performance (GDPR 6.1.b) for the
  transactional data + legal obligation (6.1.c) for fiscal retention.
- **Retention**: **7 years from last accounting entry** referencing the
  record (Spanish Código de Comercio 6 yr + 1 yr safety margin).
- The `pay:*` ledger is **NOT** deleted by `botMenu`'s 🗑 Forget —
  fiscal obligation overrides GDPR Art. 17 erasure under 17(3)(b/e).
  Session state (the cache `session.pay.*`) IS wipeable; the ledger
  stays. The Privacy submenu surfaces this honestly:

  > Tus compras y reembolsos se conservan 7 años por obligación fiscal
  > y no pueden eliminarse.

The `getStarTransactions` ledger on Telegram's side is informational
only — the plugin's `pay:charge:*` records are authoritative.

### §7 — Items confirmed not relevant

- **OSS/IOSS** — not the SOR (§1).
- **DAC7** — applies to platforms with multiple sellers; you ARE the
  seller, not a platform. Out of scope.
- **AML/KYC** at the bot level — Fragment + Apple/Google handle KYC of
  the buyer; you receive aggregated payouts from a known non-EU entity.

---

## Architecture

### Storage layout

| Key | Where | Shape |
|---|---|---|
| `session.pay.waiver` | per-user session | `{ at, version, locale } \| undefined` |
| `session.pay.credits` | per-user session | `number` |
| `session.pay.vip` | per-user session | `{ rung, chargeId, expiresAt, canceled }` |
| `session.pay.perks[id]` | per-user session | `{ chargeId, at }` |
| `pay:charge:{chargeId}` | `botSubKey(ctx, ...)` | full `ChargeRecord` |
| `pay:user:{userId}:charges` | `botSubKey(ctx, ...)` | `chargeId[]` newest-first, capped |
| `pay:refund:{chargeId}` | `botSubKey(ctx, ...)` | `{ at, refundAt, adminId, reason }` |
| `pay:payout:{batchId}` | `botSubKey(ctx, ...)` | `PayoutRecord` |
| `pay:payouts:index` | `botSubKey(ctx, ...)` | `batchId[]` |
| `pay:idempotency:{chargeId}` | `botSubKey(ctx, ...)` | sentinel ("1") |

The `pay:charge:{chargeId}` log is the **single source of truth**.
`session.pay.*` is a derived cache; `derive.ts` exposes a function that
rebuilds it from the log.

### Composition

- **`botSession`** for per-user state (auto-namespaced by bot id).
- **`botSubKey(ctx, 'pay:…')`** for the global ledger.
- **`adminContext`** for refund-approval admin DM (declared as runtime
  dependency, mirrors `accessControl`).
- **`bot/language`** for Polyglot text (waiver, menu, prompts). The
  plugin reads `ctx.session.language` directly for recipient resolution
  (admin-side notifications use the admin's stored language).
- **`bot/menu`** for the single root menu entry + submenu. The plugin
  does NOT register its own slash command — everything lives under
  `/settings`. `payments.menuItem` is the integration surface.

### Key flows

#### Purchase

```
ctx.payments.invoice(productKey)
  ↓
session.pay.waiver fresh?  ─no→  send consent prompt → user taps "✅" → persist waiver
  ↓yes
sendInvoice({ payload: encodePayload(productKey, userId, nonce),
              currency: 'XTR', prices: [{ label: name[lang], amount: xtr }],
              subscription_period: vip ? 2592000 : undefined })
  ↓
pre_checkout_query → decode payload → validate productKey → answerPreCheckoutQuery({ ok: true })
  ↓
successful_payment on message
  ↓
chargeId in pay:idempotency:{chargeId}?  ─yes→  no-op
  ↓no
write pay:charge:{chargeId}, pay:idempotency:{chargeId}, pay:user:{userId}:charges
mutate session.pay.* based on productKey:
  vip.N      → { rung: N, chargeId, expiresAt: successful_payment.subscription_expiration_date,
                 canceled: false }
  credits.M  → credits += packs[M].grants.credits
  perks.X    → perks[X] = { chargeId, at: now }
  + apply tier's grants.credits if any (vip renewal grants credits)
emit onFulfilled(productKey, ctx) — fire-and-forget; plugin always answers
```

#### Tier upgrade (vip.1 → vip.2)

User in 💎 VIP submenu, currently vip.1, taps "🌟 VIP Max" → confirm → invoice.
On fulfill: `session.pay.vip = { rung: 2, … }`. Plugin then calls
`editUserStarSubscription({ user_id, telegram_payment_charge_id: vip1ChargeId, is_canceled: true })`
to auto-cancel the lower rung's renewal. Effective tier is vip.2 immediately
(rank-based atLeast returns true for both for the leftover period; vip.1
silently expires at its end).

#### Refund (admin-mediated)

User → 💎 VIP submenu → "📜 Historial" → tap a charge → "💸 Solicitar reembolso" + reason.
Plugin marks `pay:charge.paysupportState = 'opened'` and DMs admin with the
charge details + `[✅ Aprobar] [❌ Denegar]` buttons (same pattern as
access-control).

Admin taps Aprobar → `refundStarPayment({ user_id, telegram_payment_charge_id })`.
On success: write `pay:refund:{chargeId}`, flip `paysupportState = 'refunded'`,
**re-derive** `session.pay.*` from the charge log (which now excludes this
chargeId), notify user.

#### Subscription expiry sweep

Hourly `setInterval` (`runSweep(payments, intervalMs?)`, opt-in helper):
for each user with `session.pay.vip` whose `expiresAt < now`, if there's
no fresh renewal `successful_payment`, re-derive their tier from the
charge log. Telegram doesn't push expiry events; we compute.

### Failure modes

| Situation | Behavior |
|---|---|
| `botPayments({})` missing required field | `Panic` at construction |
| Waiver text doesn't cover all bot locales | `Panic` at construction |
| `atLeast('vip.5')` when only 2 rungs | TS error at compile |
| Duplicate `successful_payment` (same chargeId) | Silent no-op via `pay:idempotency` |
| `pre_checkout_query` for unknown/invalid product | `answerPreCheckoutQuery({ ok: false, error_message })` |
| `refundStarPayment` fails | `SourcedError({ source: 'telegram', operation: 'refund', cause })`; charge stays `paysupportState: 'opened'` |
| User in middle of waiver flow, restarts | Consent isn't persisted until tap; flow restarts cleanly |
| Telegram clock-skew on `subscription_expiration_date` | Trust Telegram's value; sweep tolerates ±1h |
| `successful_payment` payload corrupted | Charge fulfilled but unattributable → admin DM alert; future flow disabled until investigated |

### What's NOT in v1 (and why)

| Feature | Reason |
|---|---|
| Stripe-outside-Telegram fiat rail | Separate channel, OSS-aware. Add behind `botPayments({ stripe: {…} })` later. |
| Crypto Pay / @CryptoBot | MiCA risk (§3). Probably never. |
| Auto-read Fragment payouts from TON wallet | Needs TON SDK. Manual `payments.payouts.record()` works fine for low volume. |
| Per-user Spanish facturas | One factura per Fragment payout is cleaner (§4). Re-evaluate at scale. |
| Annual subscriptions | Telegram supports only `period: '30d'`. Build N×30d manually if ever needed. |
| Token-usage-based credit deduction | Needs upstream `streamChat` change to surface SSE `usage` chunk. Fixed-cost-per-call works now. |
| Deep-linking `require()` → exact menu rung | v1 opens VIP root; deep-link is a follow-up (TODO marker in `plugin.ts`). |

### File layout

```
src/bot/payments/
├── CLAUDE.md       ← this file: compliance memo + design + flows
│
├── ── data + config ──
├── types.ts        ← VipRung, ChargeRecord, PayoutRecord, ProductKey, Config
├── config.ts       ← validateConfig + buildCatalog (pure, no gramio)
├── payload.ts      ← encodePayload / decodePayload (128-byte invoice payload)
├── schemas.ts      ← zod schemas for ChargeRecord + PayoutRecord (parse-on-read)
│
├── ── storage layer ──
├── stores.ts       ← buildStores(storage) → typed botRecord / botIndex / botSentinel
├── state.ts        ← pure reducers over the charge log (applyCharge, deriveState, …)
│
├── ── gramio plugin per file-convention ──
├── plugin.ts       ← wiring only (.extend + .derive + .on + .callbackQuery + .command)
├── derive.ts       ← ctx.payments builder (the gramio derive)
├── handlers.ts     ← .on() bodies: pre_checkout_query + successful_payment
├── callbacks.ts    ← .callbackQuery() bodies: waiver consent/cancel, refund close
├── commands.ts     ← .command() bodies: /paysupport
│
├── ── feature modules ──
├── waiver.ts       ← Art. 103(m) consent prompt + callback schemas + persistence
├── invoice.ts      ← sendInvoice wrappers + presentInvoice waiver gate
├── refund.ts       ← refund-request / admin-approve / deny factories + cross-user revert
├── menu-item.ts    ← payments.menuItem for botMenu (adaptive label/style/submenu)
├── payouts.ts      ← Fragment payout ledger + time-windowed gestor export
│
└── index.ts        ← public exports
```

---

## Open follow-ups (TODO)

- **Deep-link `require()` → exact submenu rung** (v2 — needs menu-state
  encoding in callback data; opens VIP root for now via the shared
  `menuNavCb` schema re-exported by `bot/menu`).
- **In-menu history view + per-charge refund tap** (v2 — needs
  per-charge `confirm` overlay + page renderer using `refundRequestCb`).
- **Token-usage credit deduction** (v2 — needs `streamChat` to surface
  the SSE `usage` chunk; fixed-cost works today).
- **Auto-Fragment payout reader** from TON wallet (v2 — TON SDK).
- **Stripe-outside-Telegram adapter** when product demand justifies it
  (separate channel + OSS).
