// What `pnpm consumers` resolves a subpath to when no package of this
// workspace exports it any more: a module with nothing in it, so every import
// from a removed subpath fails by name in the consumer instead of quietly
// resolving to the copy still installed in its node_modules.
export {};
