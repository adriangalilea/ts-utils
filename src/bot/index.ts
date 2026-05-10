/**
 * Telegram bot plugins for GramIO. Imported as subpaths so this module
 * has zero footprint for consumers that don't use them.
 *
 * Peer deps (all optional): `gramio`, `@gramio/format`, `@gramio/storage`, `marked`.
 *
 *   import { adminContext, gracefulStart } from '@adriangalilea/utils/bot/kit'
 *   import { accessControl } from '@adriangalilea/utils/bot/access-control'
 *   import { llmStream } from '@adriangalilea/utils/bot/llm-stream'
 *
 * Or all-in-one (pulls every subpath):
 *   import { ... } from '@adriangalilea/utils/bot'
 */
export * from './kit.js'
export * from './access-control.js'
export * from './llm-stream.js'
