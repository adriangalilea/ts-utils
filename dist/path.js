import { fileURLToPath } from 'url';
import { dirname, join, resolve, isAbsolute, relative, basename, extname, parse } from 'path';
/**
 * Path utilities for consistent path handling across the library
 */
class PathOps {
    /**
     * Resolve a path relative to the calling module
     * Pass import.meta.url as the second parameter to resolve relative to your module
     *
     * @example
     * // In some module, resolve a file relative to that module:
     * const configPath = path.resolve('./config.json', import.meta.url)
     */
    resolve(targetPath, baseUrl) {
        // If absolute path, return as-is
        if (isAbsolute(targetPath)) {
            return targetPath;
        }
        // If we have a base URL (import.meta.url), resolve relative to it
        if (baseUrl) {
            if (baseUrl.startsWith('file://')) {
                const basePath = fileURLToPath(baseUrl);
                const baseDir = dirname(basePath);
                return join(baseDir, targetPath);
            }
            // If baseUrl is a regular path, use it as base directory
            if (isAbsolute(baseUrl)) {
                const baseDir = dirname(baseUrl);
                return join(baseDir, targetPath);
            }
        }
        // Default to resolving from current working directory
        return resolve(process.cwd(), targetPath);
    }
    /**
     * Join path segments
     */
    join(...segments) {
        return join(...segments);
    }
    /**
     * Get the directory name of a path
     */
    dirname(p) {
        return dirname(p);
    }
    /**
     * Get the base name of a path
     */
    basename(p, ext) {
        return basename(p, ext);
    }
    /**
     * Get the extension of a path
     */
    extname(p) {
        return extname(p);
    }
    /**
     * Parse a path into its components
     */
    parse(p) {
        return parse(p);
    }
    /**
     * Check if a path is absolute
     */
    isAbsolute(p) {
        return isAbsolute(p);
    }
    /**
     * Get the relative path from one path to another
     */
    relative(from, to) {
        return relative(from, to);
    }
    /**
     * Convert a file:// URL to a path
     */
    fromFileUrl(url) {
        if (url.startsWith('file://')) {
            return fileURLToPath(url);
        }
        return url;
    }
    /**
     * Get the directory from a file:// URL
     */
    dirnameFromUrl(url) {
        return dirname(this.fromFileUrl(url));
    }
    /**
     * Resolve to absolute path
     */
    absolute(...segments) {
        return resolve(...segments);
    }
    /**
     * Get current working directory
     */
    cwd() {
        return process.cwd();
    }
}
export const path = new PathOps();
//# sourceMappingURL=path.js.map