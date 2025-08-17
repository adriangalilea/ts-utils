/**
 * Browser-safe exports for client-side usage.
 * These utilities do not depend on Node.js APIs and can run in the browser.
 *
 * Usage in Next.js client components:
 * import { log, format, currency } from '@adriangalilea/utils/browser'
 */
// Export runtime for environment detection
export { runtime } from './runtime.js';
// Universal utilities that work in browser
export * from './universal/log.js';
export * from './universal/format.js';
export * from './universal/currency/index.js';
// Offensive programming - adapted for browser (throws instead of process.exit)
export * from './offensive.js';
// Note: file, dir, path, project, and kev are NOT exported here
// because they depend on Node.js file system APIs
//# sourceMappingURL=browser.js.map