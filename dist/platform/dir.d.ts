/**
 * Directory operations that throw on error (offensive programming style)
 */
declare class DirOps {
    /**
     * Create a directory (including parents). Throws on error.
     */
    create(path: string): void;
    /**
     * Check if directory exists
     */
    exists(path: string): boolean;
    /**
     * Remove a directory and all its contents. Throws on error.
     */
    remove(path: string): void;
    /**
     * List all entries in a directory. Throws on error.
     */
    list(path: string): string[];
    /**
     * List full paths of all entries in a directory
     */
    listFull(dirPath: string): string[];
    /**
     * List only subdirectories. Throws on error.
     */
    listDirs(path: string): string[];
    /**
     * List only files (not directories). Throws on error.
     */
    listFiles(path: string): string[];
    /**
     * Check if directory is empty. Throws on error.
     */
    isEmpty(path: string): boolean;
}
export declare const dir: DirOps;
export {};
//# sourceMappingURL=dir.d.ts.map