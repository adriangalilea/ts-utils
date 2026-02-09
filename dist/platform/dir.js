import { mkdirSync, existsSync, statSync, rmSync, readdirSync } from 'fs';
import { must } from '../offensive.js';
import { path } from './path.js';
/**
 * Directory operations that throw on error (offensive programming style)
 */
class DirOps {
    /**
     * Create a directory (including parents). Throws on error.
     */
    create(path) {
        must(() => mkdirSync(path, { recursive: true, mode: 0o755 }));
    }
    /**
     * Check if directory exists
     */
    exists(path) {
        try {
            if (!existsSync(path))
                return false;
            const stats = statSync(path);
            return stats.isDirectory();
        }
        catch {
            return false;
        }
    }
    /**
     * Remove a directory and all its contents. Throws on error.
     */
    remove(path) {
        must(() => rmSync(path, { recursive: true, force: true }));
    }
    /**
     * List all entries in a directory. Throws on error.
     */
    list(path) {
        return must(() => readdirSync(path));
    }
    /**
     * List full paths of all entries in a directory
     */
    listFull(dirPath) {
        const names = this.list(dirPath);
        return names.map(name => path.join(dirPath, name));
    }
    /**
     * List only subdirectories. Throws on error.
     */
    listDirs(path) {
        return must(() => readdirSync(path, { withFileTypes: true }))
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    }
    /**
     * List only files (not directories). Throws on error.
     */
    listFiles(path) {
        return must(() => readdirSync(path, { withFileTypes: true }))
            .filter(entry => entry.isFile())
            .map(entry => entry.name);
    }
    /**
     * Check if directory is empty. Throws on error.
     */
    isEmpty(path) {
        return must(() => readdirSync(path)).length === 0;
    }
}
export const dir = new DirOps();
//# sourceMappingURL=dir.js.map