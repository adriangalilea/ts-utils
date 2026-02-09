/**
 * File operations that throw on error (offensive programming style)
 */
declare class FileOps {
    /**
     * Get the caller's file URL from the stack trace
     * This allows us to resolve relative paths from the calling module
     */
    getCallerUrl(): string | undefined;
    private resolvePath;
    /**
     * Read a file as Buffer. Throws on error.
     * Relative paths resolved from calling module.
     */
    read(filePath: string): Buffer;
    /**
     * Read a file as string. Throws on error.
     * Relative paths resolved from calling module.
     *
     * @param filePath - Path to the file
     * @param encodingOrUrl - Optional: encoding (e.g. 'utf-8') or import.meta.url for explicit resolution
     * @param encoding - Optional: encoding when second param is import.meta.url
     */
    readText(filePath: string, encodingOrUrl?: BufferEncoding | string, encoding?: BufferEncoding): string;
    /**
     * Write data to a file. Throws on error.
     * Relative paths resolved from calling module.
     */
    write(filePath: string, data: string | Buffer): void;
    /**
     * Check if file exists (not a directory)
     */
    exists(filePath: string): boolean;
    /**
     * Remove a file. Throws on error.
     */
    remove(path: string): void;
    /**
     * Get file size in bytes. Throws on error.
     */
    size(path: string): number;
    /**
     * Get file modification time. Throws on error.
     */
    mtime(path: string): Date;
}
export declare const file: FileOps;
export {};
//# sourceMappingURL=file.d.ts.map