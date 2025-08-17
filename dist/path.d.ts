/**
 * Path utilities for consistent path handling across the library
 */
declare class PathOps {
    /**
     * Resolve a path relative to the calling module
     * Pass import.meta.url as the second parameter to resolve relative to your module
     *
     * @example
     * // In some module, resolve a file relative to that module:
     * const configPath = path.resolve('./config.json', import.meta.url)
     */
    resolve(targetPath: string, baseUrl?: string): string;
    /**
     * Join path segments
     */
    join(...segments: string[]): string;
    /**
     * Get the directory name of a path
     */
    dirname(p: string): string;
    /**
     * Get the base name of a path
     */
    basename(p: string, ext?: string): string;
    /**
     * Get the extension of a path
     */
    extname(p: string): string;
    /**
     * Parse a path into its components
     */
    parse(p: string): {
        root: string;
        dir: string;
        base: string;
        ext: string;
        name: string;
    };
    /**
     * Check if a path is absolute
     */
    isAbsolute(p: string): boolean;
    /**
     * Get the relative path from one path to another
     */
    relative(from: string, to: string): string;
    /**
     * Convert a file:// URL to a path
     */
    fromFileUrl(url: string): string;
    /**
     * Get the directory from a file:// URL
     */
    dirnameFromUrl(url: string): string;
    /**
     * Resolve to absolute path
     */
    absolute(...segments: string[]): string;
    /**
     * Get current working directory
     */
    cwd(): string;
}
export declare const path: PathOps;
export {};
//# sourceMappingURL=path.d.ts.map