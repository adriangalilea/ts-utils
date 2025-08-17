import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { check } from './offensive.js';
import { path } from './path.js';
/**
 * File operations that exit on error (offensive programming style)
 */
class FileOps {
    /**
     * Get the caller's file URL from the stack trace
     * This allows us to resolve relative paths from the calling module
     */
    getCallerUrl() {
        const err = new Error();
        const stack = err.stack;
        if (!stack)
            return undefined;
        // Parse stack to find file URLs
        // Stack looks like:
        // Error
        //   at FileOps.getCallerUrl (file:///path/to/file.ts:line:col)
        //   at FileOps.readText (file:///path/to/file.ts:line:col)  
        //   at caller (file:///path/to/caller.ts:line:col) <- we want this
        const lines = stack.split('\n');
        // Try multiple regex patterns for different environments
        const patterns = [
            /\(file:\/\/([^:)]+)(?::\d+:\d+)?\)/, // Node ESM: (file:///path/file.js:1:2)
            /at file:\/\/([^:)]+)(?::\d+:\d+)?/, // Node ESM alternate: at file:///path/file.js:1:2
            /\(([^:)]+\.m?js)(?::\d+:\d+)?\)/, // Node CJS: (/path/file.js:1:2)
            /at ([^:)]+\.m?js)(?::\d+:\d+)?/, // Node CJS alternate: at /path/file.js:1:2
        ];
        // Start at line 3 to skip: Error, getCallerUrl, and the calling method (read/readText/etc)
        for (let i = 3; i < lines.length && i < 10; i++) { // Limit search depth
            const line = lines[i];
            // Skip internal file.ts/file.js lines
            if (line.includes('/file.js') || line.includes('/file.ts') ||
                line.includes('\\file.js') || line.includes('\\file.ts')) {
                continue;
            }
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    // Found a match - build file URL
                    let filePath = match[1] || match[0];
                    // Handle Windows paths
                    if (process.platform === 'win32' && !filePath.startsWith('file://')) {
                        filePath = filePath.replace(/\\/g, '/');
                    }
                    // Ensure we have a file:// URL
                    if (!filePath.startsWith('file://')) {
                        filePath = 'file://' + (filePath.startsWith('/') ? '' : '/') + filePath;
                    }
                    // Remove line and column numbers if present
                    filePath = filePath.replace(/:\d+:\d+$/, '');
                    return filePath;
                }
            }
        }
        return undefined;
    }
    /**
     * Read a file and exit on error
     * Relative paths (./file.txt) are resolved from the calling module
     * Absolute paths are used as-is
     */
    read(filePath) {
        try {
            // Auto-detect caller for relative paths
            let resolvedPath = filePath;
            if (filePath.startsWith('./') || filePath.startsWith('../')) {
                const callerUrl = this.getCallerUrl();
                resolvedPath = path.resolve(filePath, callerUrl);
            }
            else if (!path.isAbsolute(filePath)) {
                resolvedPath = path.resolve(filePath);
            }
            return readFileSync(resolvedPath);
        }
        catch (err) {
            check(err);
            throw err; // TypeScript needs this even though check exits
        }
    }
    /**
     * Read a file as string and exit on error
     * Relative paths (./file.txt) are resolved from the calling module
     * Absolute paths are used as-is
     *
     * @param filePath - Path to the file
     * @param encodingOrUrl - Optional: encoding (e.g. 'utf-8') or import.meta.url for explicit resolution
     * @param encoding - Optional: encoding when second param is import.meta.url
     */
    readText(filePath, encodingOrUrl, encoding) {
        try {
            // Determine if second param is encoding or URL
            let callerUrl;
            let actualEncoding = 'utf-8';
            if (encodingOrUrl) {
                if (encodingOrUrl.startsWith('file://') || encodingOrUrl.includes('/')) {
                    // It's a URL/path
                    callerUrl = encodingOrUrl;
                    actualEncoding = encoding || 'utf-8';
                }
                else {
                    // It's an encoding
                    actualEncoding = encodingOrUrl;
                }
            }
            // Auto-detect caller for relative paths
            let resolvedPath = filePath;
            if (filePath.startsWith('./') || filePath.startsWith('../')) {
                // Use explicit URL if provided, otherwise detect from stack
                const url = callerUrl || this.getCallerUrl();
                resolvedPath = path.resolve(filePath, url);
            }
            else if (!path.isAbsolute(filePath)) {
                resolvedPath = path.resolve(filePath);
            }
            return readFileSync(resolvedPath, actualEncoding);
        }
        catch (err) {
            check(err);
            throw err;
        }
    }
    /**
     * Write data to a file and exit on error
     * Relative paths (./file.txt) are resolved from the calling module
     * Absolute paths are used as-is
     */
    write(filePath, data) {
        try {
            // Auto-detect caller for relative paths
            let resolvedPath = filePath;
            if (filePath.startsWith('./') || filePath.startsWith('../')) {
                const callerUrl = this.getCallerUrl();
                resolvedPath = path.resolve(filePath, callerUrl);
            }
            else if (!path.isAbsolute(filePath)) {
                resolvedPath = path.resolve(filePath);
            }
            writeFileSync(resolvedPath, data, { mode: 0o644 });
        }
        catch (err) {
            check(err);
        }
    }
    /**
     * Check if file exists (not a directory)
     * Relative paths (./file.txt) are resolved from the calling module
     * Absolute paths are used as-is
     */
    exists(filePath) {
        try {
            // Auto-detect caller for relative paths
            let resolvedPath = filePath;
            if (filePath.startsWith('./') || filePath.startsWith('../')) {
                const callerUrl = this.getCallerUrl();
                resolvedPath = path.resolve(filePath, callerUrl);
            }
            else if (!path.isAbsolute(filePath)) {
                resolvedPath = path.resolve(filePath);
            }
            if (!existsSync(resolvedPath))
                return false;
            const stats = statSync(resolvedPath);
            return stats.isFile();
        }
        catch {
            return false;
        }
    }
    /**
     * Remove a file and exit on error
     */
    remove(path) {
        try {
            unlinkSync(path);
        }
        catch (err) {
            check(err);
        }
    }
    /**
     * Get file size in bytes
     */
    size(path) {
        try {
            const stats = statSync(path);
            return stats.size;
        }
        catch (err) {
            check(err);
            throw err;
        }
    }
    /**
     * Get file modification time
     */
    mtime(path) {
        try {
            const stats = statSync(path);
            return stats.mtime;
        }
        catch (err) {
            check(err);
            throw err;
        }
    }
}
export const file = new FileOps();
//# sourceMappingURL=file.js.map