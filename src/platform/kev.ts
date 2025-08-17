/**
 * KEV - A Redis-style KV store for environment variables
 * 
 * DEFAULT USAGE (no namespaces needed!):
 *   apiKey = KEV.mustGet("API_KEY")      // Panics if not found (required config)
 *   apiKey = KEV.get("API_KEY")          // Returns "" if not found
 *   apiKey = KEV.get("API_KEY", "dev")   // Returns "dev" if not found
 *   port = KEV.int("PORT", 8080)         // With type conversion
 *   KEV.set("DEBUG", "true")             // Sets in memory (fast)
 *   
 *   KEV.get("DATABASE_URL")              // memory → process.env → .env → cache result
 *   KEV.get("DATABASE_URL")              // memory (cached!) ✓
 *
 * CUSTOMIZE THE SEARCH ORDER:
 *   KEV.source.remove("os")              // Ignore OS env (perfect for tests!)
 *   KEV.source.add(".env.local")         // Add more fallbacks
 *   KEV.source.set(".env.test")          // Or replace entirely
 *
 * REDIS-STYLE NAMESPACING (when you need control):
 *   KEV.get("os:PATH")                   // ONLY from OS, no fallback
 *   KEV.get(".env:API_KEY")              // ONLY from .env file
 *   KEV.set("os:DEBUG", "true")          // Write directly to OS
 *   KEV.set(".env:API_KEY", "secret")    // Update .env file
 *
 *   // Pattern matching
 *   KEV.keys("API_*")                    // Find all API_ keys
 *   KEV.all("os:*")                      // Get all OS vars
 *   KEV.clear("TEMP_*")                  // Clean up temp vars
 *
 * SOURCE TRACKING & OBSERVABILITY:
 *   const [value, source] = KEV.getWithSource("API_KEY")  // Returns value + where it came from
 *   source = KEV.sourceOf("API_KEY")                      // "/path/to/project/.env"
 *   KEV.debug = true                                       // Shows lookup chain
 *   KEV.export("backup.env")                              // Includes # from: comments
 */

import { runtime } from '../runtime.js'
import { panic } from '../offensive.js'
import { file } from './file.js'
import { path } from './path.js'
import { findProjectRoot, findMonorepoRoot } from './project.js'

interface MemEntry {
  value: string
  source: string // "os", ".env", "../.env", "default", "set", etc.
}

class SourceOps {
  constructor(private kev: KevOps) {}

  /**
   * Replace all sources
   */
  set(...sources: string[]): void {
    this.kev.sources = sources
  }

  /**
   * Add sources to the search list
   */
  add(...sources: string[]): void {
    this.kev.sources.push(...sources)
  }

  /**
   * Remove specific sources
   */
  remove(...sources: string[]): void {
    this.kev.sources = this.kev.sources.filter(s => !sources.includes(s))
  }

  /**
   * List current sources
   */
  list(): string[] {
    return [...this.kev.sources]
  }

  /**
   * Clear all sources
   */
  clear(): void {
    this.kev.sources = []
  }
}

export class KevOps {
  memory = new Map<string, MemEntry>()
  sources: string[] = ['os', '.env']
  source: SourceOps
  debug = false

  constructor() {
    this.source = new SourceOps(this)
    this.initializeSmartDefaults()
  }

  initializeSmartDefaults(): void {
    // Check for monorepo root first (turborepo)
    const monorepoRoot = findMonorepoRoot()
    if (monorepoRoot) {
      const monorepoEnv = path.join(monorepoRoot, '.env')
      this.sources.push(monorepoEnv)
      
      if (this.debug) {
        console.log('KEV: Auto-discovered monorepo root:', monorepoRoot)
        console.log('KEV: Added monorepo .env to sources:', monorepoEnv)
      }
    }

    // Then check for project root
    const projectRoot = findProjectRoot()
    if (projectRoot) {
      const projectEnv = path.join(projectRoot, '.env')
      // Only add if it's different from monorepo env
      if (!monorepoRoot || projectEnv !== path.join(monorepoRoot, '.env')) {
        this.sources.push(projectEnv)
        
        if (this.debug) {
          console.log('KEV: Auto-discovered project root:', projectRoot)
          console.log('KEV: Added project .env to sources:', projectEnv)
        }
      }
    }

    if (this.debug) {
      if (!monorepoRoot && !projectRoot) {
        console.log('KEV: No project or monorepo root found, using standard sources:', this.sources)
      } else {
        console.log('KEV: Default sources:', this.sources)
      }
    }
  }

  parseKey(key: string): [string, string] {
    if (key.startsWith(':')) {
      panic('invalid key format - starts with colon:', key)
    }
    if (key.includes('::')) {
      panic('invalid key format - double colon:', key)
    }

    const parts = key.split(':', 2)
    if (parts.length === 2) {
      if (parts[0] === '' || parts[1] === '') {
        panic('invalid key format - empty namespace or key:', key)
      }
      return [parts[0], parts[1]]
    }
    return ['', key]
  }

  /**
   * Get environment variable with optional default.
   */
  get(key: string, defaultValue?: string): string {
    const [namespace, realKey] = this.parseKey(key)
    
    const debug = this.debug && key !== 'LOG_LEVEL'
    
    if (debug) {
      console.log(`KEV: Looking for ${key}`)
    }

    // Namespaced - direct access
    if (namespace) {
      const val = this.getFromNamespace(namespace, realKey)
      if (val !== '') {
        if (debug) {
          console.log(`  ✓ ${namespace}: found ${val}`)
        }
        return val
      }
      if (debug) {
        console.log(`  ✗ ${namespace}: not found`)
      }
      if (defaultValue !== undefined) {
        if (debug) {
          console.log(`  → using default: ${defaultValue}`)
        }
        return defaultValue
      }
      return ''
    }

    // Unnamespaced - check memory first
    const entry = this.memory.get(realKey)
    if (entry) {
      if (debug) {
        console.log(`  ✓ memory: ${entry.value} (from ${entry.source})`)
      }
      return entry.value
    }

    if (debug) {
      console.log('  ✗ memory: not found')
    }

    // Search through sources
    for (const source of this.sources) {
      const val = this.getFromNamespace(source, realKey)
      if (val !== '') {
        if (debug) {
          console.log(`  ✓ ${source}: found ${val} (caching)`)
        }
        // Cache in memory for next time with source info
        const absoluteSource = source !== 'os' && source !== 'default' && source !== 'set' 
          ? path.absolute(source) 
          : source
        this.memory.set(realKey, { value: val, source: absoluteSource })
        return val
      }
      if (debug) {
        console.log(`  ✗ ${source}: not found`)
      }
    }

    // Use default and cache it
    if (defaultValue !== undefined) {
      if (debug) {
        console.log(`  → using default: ${defaultValue} (caching)`)
      }
      this.memory.set(realKey, { value: defaultValue, source: 'default' })
      return defaultValue
    }

    if (debug) {
      console.log('  → not found, returning empty')
    }
    return ''
  }

  /**
   * Get environment variable or panic if not found
   */
  mustGet(key: string): string {
    const val = this.get(key)
    if (val === '') {
      panic('required key not found:', key)
    }
    return val
  }

  /**
   * Get where a cached key came from
   */
  sourceOf(key: string): string {
    const entry = this.memory.get(key)
    return entry ? entry.source : ''
  }

  /**
   * Get both value and its source
   */
  getWithSource(key: string, defaultValue?: string): [string, string] {
    const value = this.get(key, defaultValue)
    if (value !== '') {
      let source = this.sourceOf(key)
      // If not in cache but has value, it might be a namespaced get
      if (!source) {
        const [namespace] = this.parseKey(key)
        if (namespace) {
          source = namespace
        }
      }
      return [value, source]
    }
    return ['', '']
  }

  getFromNamespace(namespace: string, key: string): string {
    switch (namespace) {
      case 'os':
        return runtime.env(key) || ''
      default:
        // File namespace (.env, .env.local, etc)
        if (namespace.startsWith('.') || namespace.includes('/')) {
          return this.getFromFile(namespace, key)
        }
    }
    return ''
  }

  getFromFile(filePath: string, key: string): string {
    if (!file.exists(filePath)) {
      return ''
    }

    try {
      const content = file.readText(filePath)
      const lines = content.split('\n')
      
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) {
          continue
        }

        const parts = trimmed.split('=', 2)
        if (parts.length === 2) {
          const fileKey = parts[0].trim()
          if (fileKey === key) {
            let value = parts[1].trim()
            // Remove quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1)
            }
            return value
          }
        }
      }
    } catch {
      // File read error
    }
    return ''
  }

  /**
   * Set environment variable
   */
  set(key: string, value: string): void {
    const [namespace, realKey] = this.parseKey(key)

    // Namespaced - direct write
    if (namespace) {
      this.setToNamespace(namespace, realKey, value)
      return
    }

    // Unnamespaced - memory only
    this.memory.set(realKey, { value, source: 'set' })
  }

  setToNamespace(namespace: string, key: string, value: string): void {
    switch (namespace) {
      case 'os':
        runtime.setEnv(key, value)
        break
      default:
        // File namespace - update or append to file
        if (namespace.startsWith('.') || namespace.includes('/')) {
          this.setToFile(namespace, key, value)
        }
    }
  }

  setToFile(path: string, key: string, value: string): void {
    const lines: string[] = []
    let found = false

    if (file.exists(path)) {
      const content = file.readText(path)
      const existingLines = content.split('\n')
      
      for (const line of existingLines) {
        const trimmed = line.trim()
        
        // Keep empty lines and comments
        if (trimmed === '' || trimmed.startsWith('#')) {
          lines.push(line)
          continue
        }

        // Check if this is the key we're updating
        const parts = trimmed.split('=', 2)
        if (parts.length >= 1) {
          const fileKey = parts[0].trim()
          if (fileKey === key) {
            // Update existing key
            const quotedValue = value.includes(' ') || value.includes('\t') || value.includes('\n')
              ? `"${value}"`
              : value
            lines.push(`${key}=${quotedValue}`)
            found = true
          } else {
            lines.push(line)
          }
        } else {
          lines.push(line)
        }
      }
    }

    // If key wasn't found, append it
    if (!found) {
      const quotedValue = value.includes(' ') || value.includes('\t') || value.includes('\n')
        ? `"${value}"`
        : value
      lines.push(`${key}=${quotedValue}`)
    }

    // Write back
    file.write(path, lines.join('\n'))
  }

  /**
   * Check if key exists
   */
  has(key: string): boolean {
    const [namespace, realKey] = this.parseKey(key)

    // Namespaced - check directly
    if (namespace) {
      return this.hasInNamespace(namespace, realKey)
    }

    // Unnamespaced - check memory then sources
    if (this.memory.has(realKey)) {
      return true
    }

    // Check sources
    for (const source of this.sources) {
      if (this.hasInNamespace(source, realKey)) {
        return true
      }
    }

    return false
  }

  hasInNamespace(namespace: string, key: string): boolean {
    switch (namespace) {
      case 'os':
        return runtime.hasEnv(key)
      default:
        // File namespace
        if (namespace.startsWith('.') || namespace.includes('/')) {
          return this.getFromFile(namespace, key) !== ''
        }
    }
    return false
  }

  /**
   * Get all keys matching pattern
   */
  keys(pattern = '*'): string[] {
    const seen = new Set<string>()
    const result: string[] = []

    const patterns = Array.isArray(pattern) ? pattern : [pattern]

    for (const pat of patterns) {
      const [namespace, keyPattern] = this.parseKey(pat)

      if (namespace) {
        // Namespaced pattern
        const nsKeys = this.keysFromNamespace(namespace, keyPattern)
        for (const key of nsKeys) {
          const fullKey = `${namespace}:${key}`
          if (!seen.has(fullKey)) {
            result.push(fullKey)
            seen.add(fullKey)
          }
        }
      } else {
        // Unnamespaced - get from memory and sources
        for (const [key] of this.memory) {
          if (this.matchPattern(key, keyPattern) && !seen.has(key)) {
            result.push(key)
            seen.add(key)
          }
        }

        // Also check sources
        for (const source of this.sources) {
          const nsKeys = this.keysFromNamespace(source, keyPattern)
          for (const key of nsKeys) {
            if (!seen.has(key)) {
              result.push(key)
              seen.add(key)
            }
          }
        }
      }
    }

    return result
  }

  keysFromNamespace(namespace: string, pattern: string): string[] {
    const data = this.getNamespaceData(namespace, pattern, true)
    return Object.keys(data)
  }

  getNamespaceData(namespace: string, pattern: string, keysOnly: boolean): Record<string, string> {
    const result: Record<string, string> = {}

    switch (namespace) {
      case 'os':
        for (const [key, value] of Object.entries(runtime.allEnv())) {
          if (this.matchPattern(key, pattern)) {
            result[key] = keysOnly ? '' : value || ''
          }
        }
        break
      default:
        // File namespace
        if (namespace.startsWith('.') || namespace.includes('/')) {
          this.parseEnvFile(namespace, pattern, result, keysOnly)
        }
    }

    return result
  }

  parseEnvFile(path: string, pattern: string, result: Record<string, string>, keysOnly: boolean): void {
    if (!file.exists(path)) {
      return
    }

    try {
      const content = file.readText(path)
      const lines = content.split('\n')

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) {
          continue
        }

        const parts = trimmed.split('=', 2)
        if (parts.length >= 1) {
          const key = parts[0].trim()
          if (this.matchPattern(key, pattern)) {
            if (keysOnly) {
              result[key] = ''
            } else if (parts.length === 2) {
              let value = parts[1].trim()
              // Remove quotes
              if ((value.startsWith('"') && value.endsWith('"')) ||
                  (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1)
              }
              result[key] = value
            }
          }
        }
      }
    } catch {
      // File read error
    }
  }

  matchPattern(key: string, pattern: string): boolean {
    if (pattern === '*') return true
    if (pattern.endsWith('*')) {
      const prefix = pattern.slice(0, -1)
      return key.startsWith(prefix)
    }
    if (pattern.startsWith('*')) {
      const suffix = pattern.slice(1)
      return key.endsWith(suffix)
    }
    if (pattern.includes('*')) {
      const parts = pattern.split('*')
      if (parts.length === 2) {
        return key.startsWith(parts[0]) && key.endsWith(parts[1])
      }
    }
    return key === pattern
  }

  /**
   * Get all variables matching patterns
   */
  all(pattern?: string | string[]): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {}
    const patterns = pattern ? (Array.isArray(pattern) ? pattern : [pattern]) : []

    if (patterns.length === 0) {
      // Default - return memory only with source info
      if (this.memory.size > 0) {
        const memCopy: Record<string, string> = {}
        for (const [key, entry] of this.memory) {
          memCopy[key] = `${entry.value} [from: ${entry.source}]`
        }
        result.memory = memCopy
      }
      return result
    }

    // Check if any pattern has namespace
    const hasNamespace = patterns.some(p => p.includes(':'))

    if (!hasNamespace) {
      // No namespaces - get from memory and all sources
      const memMatches: Record<string, string> = {}
      for (const [key, entry] of this.memory) {
        for (const pat of patterns) {
          if (this.matchPattern(key, pat)) {
            memMatches[key] = `${entry.value} [from: ${entry.source}]`
            break
          }
        }
      }
      if (Object.keys(memMatches).length > 0) {
        result.memory = memMatches
      }

      // Check all sources
      for (const source of this.sources) {
        const sourceMatches: Record<string, string> = {}
        const sourceVars = this.getAllFromNamespace(source, '*')
        for (const [key, val] of Object.entries(sourceVars)) {
          for (const pat of patterns) {
            if (this.matchPattern(key, pat)) {
              sourceMatches[key] = val
              break
            }
          }
        }
        if (Object.keys(sourceMatches).length > 0) {
          result[source] = sourceMatches
        }
      }
      return result
    }

    // Special case for *:*
    if (patterns.length === 1 && patterns[0] === '*:*') {
      // Add memory
      if (this.memory.size > 0) {
        const memCopy: Record<string, string> = {}
        for (const [key, entry] of this.memory) {
          memCopy[key] = `${entry.value} [from: ${entry.source}]`
        }
        result.memory = memCopy
      }

      // Add all sources
      for (const source of this.sources) {
        const sourceVars = this.getAllFromNamespace(source, '*')
        if (Object.keys(sourceVars).length > 0) {
          result[source] = sourceVars
        }
      }
    } else {
      // Process specific patterns
      for (const pat of patterns) {
        const [namespace, keyPattern] = this.parseKey(pat)
        if (namespace) {
          const nsVars = this.getAllFromNamespace(namespace, keyPattern)
          if (Object.keys(nsVars).length > 0) {
            if (!result[namespace]) {
              result[namespace] = {}
            }
            Object.assign(result[namespace], nsVars)
          }
        }
      }
    }

    return result
  }

  getAllFromNamespace(namespace: string, pattern: string): Record<string, string> {
    return this.getNamespaceData(namespace, pattern, false)
  }

  /**
   * Clear variables from memory
   */
  clear(...patterns: string[]): void {
    // Only allow memory clearing for safety
    for (const pattern of patterns) {
      if (pattern.includes(':')) {
        panic('Clear() with namespace is dangerous! Use clearUnsafe() if you really need this.')
      }
    }

    if (patterns.length === 0) {
      // Clear all memory
      this.memory.clear()
      return
    }

    // Clear patterns from memory only
    for (const pattern of patterns) {
      for (const key of this.memory.keys()) {
        if (this.matchPattern(key, pattern)) {
          this.memory.delete(key)
        }
      }
    }
  }

  /**
   * Clear from namespaces (dangerous!)
   */
  clearUnsafe(...patterns: string[]): void {
    for (const pattern of patterns) {
      const [namespace, keyPattern] = this.parseKey(pattern)

      if (!namespace) {
        // No namespace - just use regular clear
        this.clear(pattern)
        continue
      }

      switch (namespace) {
        case 'os':
          if (keyPattern === '*') {
            panic('clearUnsafe("os:*") would destroy system! This is never allowed.')
          }
          const keys = this.keysFromNamespace('os', keyPattern)
          for (const key of keys) {
            runtime.deleteEnv(key)
          }
          break
        default:
          panic('Clearing from files not yet implemented')
      }
    }
  }

  /**
   * Remove specific keys
   */
  unset(...keys: string[]): void {
    for (const key of keys) {
      const [namespace, realKey] = this.parseKey(key)

      if (namespace) {
        // Namespaced unset
        switch (namespace) {
          case 'os':
            runtime.deleteEnv(realKey)
            break
          default:
            panic('Unsetting from files not yet implemented')
        }
      } else {
        // Unnamespaced - remove from memory
        this.memory.delete(realKey)
      }
    }
  }

  /**
   * Get as integer with default
   */
  int(key: string, defaultValue: number): number {
    const val = this.get(key)
    if (val === '') {
      return defaultValue
    }

    const i = parseInt(val, 10)
    if (isNaN(i)) {
      panic(`invalid int value for ${key}: ${val}`)
    }
    return i
  }

  /**
   * Get as boolean with default
   */
  bool(key: string, defaultValue: boolean): boolean {
    const val = this.get(key).toLowerCase()
    if (val === '') {
      return defaultValue
    }

    switch (val) {
      case 'true':
      case '1':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case '0':
      case 'no':
      case 'off':
        return false
      default:
        panic(`invalid bool value for ${key}: ${val}`)
    }
  }

  /**
   * Get as float with default
   */
  float(key: string, defaultValue: number): number {
    const val = this.get(key)
    if (val === '') {
      return defaultValue
    }

    const f = parseFloat(val)
    if (isNaN(f)) {
      panic(`invalid float value for ${key}: ${val}`)
    }
    return f
  }

  /**
   * Export all memory variables to a file
   */
  export(path: string): void {
    const lines: string[] = []
    for (const [key, entry] of this.memory) {
      let val = entry.value
      // Escape values with spaces or special chars
      if (val.includes(' ') || val.includes('\t') || val.includes('\n')) {
        val = `"${val}"`
      }
      // Add comment with source info
      lines.push(`${key}=${val}  # from: ${entry.source}`)
    }
    file.write(path, lines.join('\n'))
  }

  /**
   * Print all environment variables (masks sensitive keys)
   */
  dump(): void {
    const all = this.all()

    for (const [namespace, vars] of Object.entries(all)) {
      for (const [key, val] of Object.entries(vars)) {
        let maskedVal = val
        // Mask sensitive values
        const lower = key.toLowerCase()
        if (lower.includes('key') || 
            lower.includes('secret') || 
            lower.includes('password') || 
            lower.includes('token')) {
          if (val.length > 4) {
            maskedVal = val.slice(0, 4) + '****'
          } else {
            maskedVal = '****'
          }
        }
        console.log(`${namespace}:${key}=${maskedVal}`)
      }
    }
  }
}

// Create singleton instance
export const kev = new KevOps()