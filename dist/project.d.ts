/**
 * Find project root by walking up from current directory looking for project markers.
 * Checks for: package.json, tsconfig.json, .git, deno.json
 */
export declare function findProjectRoot(): string;
/**
 * Find project root from a specific directory
 */
export declare function findProjectRootFrom(startDir: string): string;
/**
 * Find monorepo root by walking up looking for turborepo markers.
 * Checks for: turbo.json, pnpm-workspace.yaml, lerna.json
 */
export declare function findMonorepoRoot(): string;
/**
 * Find monorepo root from a specific directory
 */
export declare function findMonorepoRootFrom(startDir: string): string;
/**
 * Get the nearest package.json data
 */
export declare function getPackageJson(): any | null;
/**
 * Check if current project is a TypeScript project
 */
export declare function isTypeScriptProject(): boolean;
export declare const project: {
    findProjectRoot: typeof findProjectRoot;
    findProjectRootFrom: typeof findProjectRootFrom;
    findMonorepoRoot: typeof findMonorepoRoot;
    findMonorepoRootFrom: typeof findMonorepoRootFrom;
    getPackageJson: typeof getPackageJson;
    isTypeScriptProject: typeof isTypeScriptProject;
};
export default project;
//# sourceMappingURL=project.d.ts.map