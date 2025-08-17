import { mkdirSync, existsSync, statSync, rmSync, readdirSync } from 'fs'
import { check } from './offensive.js'
import { path } from './path.js'

/**
 * Directory operations that exit on error (offensive programming style)
 */
class DirOps {
  /**
   * Create a directory (including parents) and exit on error
   */
  create(path: string): void {
    try {
      mkdirSync(path, { recursive: true, mode: 0o755 })
    } catch (err) {
      check(err)
    }
  }

  /**
   * Check if directory exists
   */
  exists(path: string): boolean {
    try {
      if (!existsSync(path)) return false
      const stats = statSync(path)
      return stats.isDirectory()
    } catch {
      return false
    }
  }

  /**
   * Remove a directory and all its contents, exit on error
   */
  remove(path: string): void {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (err) {
      check(err)
    }
  }

  /**
   * List all entries in a directory, exit on error
   */
  list(path: string): string[] {
    try {
      return readdirSync(path)
    } catch (err) {
      check(err)
      throw err
    }
  }

  /**
   * List full paths of all entries in a directory
   */
  listFull(dirPath: string): string[] {
    const names = this.list(dirPath)
    return names.map(name => path.join(dirPath, name))
  }

  /**
   * List only subdirectories
   */
  listDirs(path: string): string[] {
    try {
      const entries = readdirSync(path, { withFileTypes: true })
      return entries
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch (err) {
      check(err)
      throw err
    }
  }

  /**
   * List only files (not directories)
   */
  listFiles(path: string): string[] {
    try {
      const entries = readdirSync(path, { withFileTypes: true })
      return entries
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
    } catch (err) {
      check(err)
      throw err
    }
  }

  /**
   * Check if directory is empty
   */
  isEmpty(path: string): boolean {
    try {
      const entries = readdirSync(path)
      return entries.length === 0
    } catch (err) {
      check(err)
      throw err
    }
  }
}

export const dir = new DirOps()
export const Dir = dir // Capitalized alias to match Go style

export default dir