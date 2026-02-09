/**
 * Main entry point for @adriangalilea/utils
 * Exports all utilities
 */
// Always export runtime - it's the foundation
export { runtime } from './runtime.js';
// Universal utilities - work everywhere
export * from './universal/log.js';
export * from './universal/format.js';
export * from './universal/currency/index.js';
// Offensive programming - pure throws, zero dependencies
export * from './offensive.js';
// Platform-specific utilities
// These will throw helpful errors in browser environment when used
export * from './platform/file.js';
export * from './platform/dir.js';
export * from './platform/path.js';
export * from './platform/project.js';
export * from './platform/kev.js';
//# sourceMappingURL=index.js.map