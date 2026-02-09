import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'fs'
import { must } from '../offensive.js'
import { path } from './path.js'

/**
 * File operations that throw on error (offensive programming style)
 */
class FileOps {
  /**
   * Get the caller's file URL from the stack trace
   * This allows us to resolve relative paths from the calling module
   */
  getCallerUrl(): string | undefined {
    const err = new Error()
    const stack = err.stack
    if (!stack) return undefined

    // Parse stack to find file URLs
    // Stack looks like:
    // Error
    //   at FileOps.getCallerUrl (file:///path/to/file.ts:line:col)
    //   at FileOps.readText (file:///path/to/file.ts:line:col)
    //   at caller (file:///path/to/caller.ts:line:col) <- we want this

    const lines = stack.split('\n')

    // Try multiple regex patterns for different environments
    const patterns = [
      /\(file:\/\/([^:)]+)(?::\d+:\d+)?\)/, // Node ESM: (file:///path/file.js:1:2)
      /at file:\/\/([^:)]+)(?::\d+:\d+)?/,   // Node ESM alternate: at file:///path/file.js:1:2
      /\(([^:)]+\.m?js)(?::\d+:\d+)?\)/,     // Node CJS: (/path/file.js:1:2)
      /at ([^:)]+\.m?js)(?::\d+:\d+)?/,      // Node CJS alternate: at /path/file.js:1:2
    ]

    // Start at line 3 to skip: Error, getCallerUrl, and the calling method (read/readText/etc)
    for (let i = 3; i < lines.length && i < 10; i++) { // Limit search depth
      const line = lines[i]

      // Skip internal file.ts/file.js lines
      if (line.includes('/file.js') || line.includes('/file.ts') ||
          line.includes('\\file.js') || line.includes('\\file.ts')) {
        continue
      }

      for (const pattern of patterns) {
        const match = line.match(pattern)
        if (match) {
          // Found a match - build file URL
          let filePath = match[1] || match[0]

          // Handle Windows paths
          if (process.platform === 'win32' && !filePath.startsWith('file://')) {
            filePath = filePath.replace(/\\/g, '/')
          }

          // Ensure we have a file:// URL
          if (!filePath.startsWith('file://')) {
            filePath = 'file://' + (filePath.startsWith('/') ? '' : '/') + filePath
          }

          // Remove line and column numbers if present
          filePath = filePath.replace(/:\d+:\d+$/, '')

          return filePath
        }
      }
    }

    return undefined
  }

  private resolvePath(filePath: string): string {
    if (filePath.startsWith('./') || filePath.startsWith('../')) {
      const callerUrl = this.getCallerUrl()
      return path.resolve(filePath, callerUrl)
    }
    if (!path.isAbsolute(filePath)) {
      return path.resolve(filePath)
    }
    return filePath
  }

  /**
   * Read a file as Buffer. Throws on error.
   * Relative paths resolved from calling module.
   */
  read(filePath: string): Buffer {
    const resolved = this.resolvePath(filePath)
    return must(() => readFileSync(resolved))
  }

  /**
   * Read a file as string. Throws on error.
   * Relative paths resolved from calling module.
   *
   * @param filePath - Path to the file
   * @param encodingOrUrl - Optional: encoding (e.g. 'utf-8') or import.meta.url for explicit resolution
   * @param encoding - Optional: encoding when second param is import.meta.url
   */
  readText(filePath: string, encodingOrUrl?: BufferEncoding | string, encoding?: BufferEncoding): string {
    let callerUrl: string | undefined
    let actualEncoding: BufferEncoding = 'utf-8'

    if (encodingOrUrl) {
      if (encodingOrUrl.startsWith('file://') || encodingOrUrl.includes('/')) {
        callerUrl = encodingOrUrl
        actualEncoding = encoding || 'utf-8'
      } else {
        actualEncoding = encodingOrUrl as BufferEncoding
      }
    }

    let resolvedPath = filePath
    if (filePath.startsWith('./') || filePath.startsWith('../')) {
      const url = callerUrl || this.getCallerUrl()
      resolvedPath = path.resolve(filePath, url)
    } else if (!path.isAbsolute(filePath)) {
      resolvedPath = path.resolve(filePath)
    }

    return must(() => readFileSync(resolvedPath, actualEncoding))
  }

  /**
   * Write data to a file. Throws on error.
   * Relative paths resolved from calling module.
   */
  write(filePath: string, data: string | Buffer): void {
    const resolved = this.resolvePath(filePath)
    must(() => writeFileSync(resolved, data, { mode: 0o644 }))
  }

  /**
   * Check if file exists (not a directory)
   */
  exists(filePath: string): boolean {
    try {
      const resolved = this.resolvePath(filePath)
      if (!existsSync(resolved)) return false
      const stats = statSync(resolved)
      return stats.isFile()
    } catch {
      return false
    }
  }

  /**
   * Remove a file. Throws on error.
   */
  remove(path: string): void {
    must(() => unlinkSync(path))
  }

  /**
   * Get file size in bytes. Throws on error.
   */
  size(path: string): number {
    return must(() => statSync(path)).size
  }

  /**
   * Get file modification time. Throws on error.
   */
  mtime(path: string): Date {
    return must(() => statSync(path)).mtime
  }
}

export const file = new FileOps()
