/**
 * Browser-safe exports for client-side usage.
 * These utilities do not depend on Node.js APIs and can run in the browser.
 *
 * Usage in Next.js client components:
 * import { log, format, currency } from '@adriangalilea/utils/browser'
 */
export { runtime } from './runtime.js';
export type { RuntimeCapabilities } from './runtime.js';
export * from './universal/log.js';
export * from './universal/format.js';
export * from './universal/currency/index.js';
export * from './offensive.js';
//# sourceMappingURL=browser.d.ts.map