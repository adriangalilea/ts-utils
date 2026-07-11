/**
 * Telegram bot plugins for GramIO. Imported as subpaths so this module
 * has zero footprint for consumers that don't use them.
 *
 * Peer deps (all optional): `gramio`, `@gramio/format`, `@gramio/storage`, `marked`.
 *
 *   import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
 *   import { accessControl } from '@adriangalilea/utils/bot/access-control'
 *   import { llmStream } from '@adriangalilea/utils/bot/llm'
 *
 * Or all-in-one (pulls every subpath):
 *   import { ... } from '@adriangalilea/utils/bot'
 */

export * from "./access-control.js";
export * from "./admin.js";
export * from "./callbacks.js";
export * from "./coalesce.js";
export * from "./ctx.js";
export * from "./groups.js";
export * from "./keys.js";
export * from "./kit.js";
export * from "./language.js";
export * from "./llm.js";
export * from "./menu.js";
export * from "./notify.js";
export * from "./payments/index.js";
export * from "./storage.js";
export * from "./user.js";
