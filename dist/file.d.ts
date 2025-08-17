/**
 * File operations that exit on error (offensive programming style)
 */
declare class FileOps {
    /**
     * Get the caller's file URL from the stack trace
     * This allows us to resolve relative paths from the calling module
     */
    getCallerUrl(): string | undefined;
    /**
     * Read a file and exit on error
     * Relative paths (./file.txt) are resolved from the calling module
     * Absolute paths are used as-is
     */
    read(filePath: string): Buffer;
    /**
     * Read a file as string and exit on error
     * Relative paths (./file.txt) are resolved from the calling module
     * Absolute paths are used as-is
     *
     * @param filePath - Path to the file
     * @param encodingOrUrl - Optional: encoding (e.g. 'utf-8') or import.meta.url for explicit resolution
     * @param encoding - Optional: encoding when second param is import.meta.url
     */
    readText(filePath: string, encodingOrUrl?: BufferEncoding | string, encoding?: BufferEncoding): string;
    /**
     * Write data to a file and exit on error
     * Relative paths (./file.txt) are resolved from the calling module
     * Absolute paths are used as-is
     */
    write(filePath: string, data: string | Buffer): void;
    /**
     * Check if file exists (not a directory)
     * Relative paths (./file.txt) are resolved from the calling module
     * Absolute paths are used as-is
     */
    exists(filePath: string): boolean;
    /**
     * Remove a file and exit on error
     */
    remove(path: string): void;
    /**
     * Get file size in bytes
     */
    size(path: string): number;
    /**
     * Get file modification time
     */
    mtime(path: string): Date;
}
export declare const file: FileOps;
export declare const File: FileOps;
export default file;
//# sourceMappingURL=file.d.ts.map