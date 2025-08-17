/**
 * Directory operations that exit on error (offensive programming style)
 */
declare class DirOps {
    /**
     * Create a directory (including parents) and exit on error
     */
    create(path: string): void;
    /**
     * Check if directory exists
     */
    exists(path: string): boolean;
    /**
     * Remove a directory and all its contents, exit on error
     */
    remove(path: string): void;
    /**
     * List all entries in a directory, exit on error
     */
    list(path: string): string[];
    /**
     * List full paths of all entries in a directory
     */
    listFull(dirPath: string): string[];
    /**
     * List only subdirectories
     */
    listDirs(path: string): string[];
    /**
     * List only files (not directories)
     */
    listFiles(path: string): string[];
    /**
     * Check if directory is empty
     */
    isEmpty(path: string): boolean;
}
export declare const dir: DirOps;
export declare const Dir: DirOps;
export default dir;
//# sourceMappingURL=dir.d.ts.map