/**
 * Main entry point for @adriangalilea/utils
 * Exports all utilities
 */

// Offensive programming - pure throws, zero dependencies
export * from "./offensive.js";
export * from "./platform/dir.js";
// Platform-specific utilities
// These will throw helpful errors in browser environment when used
export * from "./platform/file.js";
export * from "./platform/kev.js";
export * from "./platform/path.js";
export * from "./platform/project.js";
export * from "./platform/unseen.js";
export * from "./platform/xdg.js";
export type { RuntimeCapabilities } from "./runtime.js";
// Always export runtime - it's the foundation
export { ProcessExitError, runtime } from "./runtime.js";
// Polyglot strings — TS-enforced multi-language values
export * from "./say/index.js";
export * from "./universal/currency/index.js";
export * from "./universal/format.js";
// Universal utilities - work everywhere
export * from "./universal/log.js";
export * from "./universal/url/index.js";
