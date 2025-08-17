/**
 * Runtime detection and capability checking primitive.
 * This is the foundation for all environment-specific behavior.
 * 
 * All utilities should use this module instead of directly checking
 * for process, window, Deno, etc.
 */

interface RuntimeCapabilities {
  // Environment detection
  readonly isBrowser: boolean
  readonly isNode: boolean
  readonly isDeno: boolean
  readonly isBun: boolean
  
  // Capability checking
  canExit(): boolean
  canReadEnv(): boolean
  canWriteEnv(): boolean
  canFileSystem(): boolean
  canNetwork(): boolean
  canCrypto(): boolean
  
  // Platform-agnostic operations
  exit(code: number): never
  env(key: string): string | undefined
  setEnv(key: string, value: string): void
  deleteEnv(key: string): void
  hasEnv(key: string): boolean
  allEnv(): Record<string, string>
  cwd(): string
  stdout: {
    write(message: string): void
    isTTY: boolean
  }
  stderr: {
    write(message: string): void
    isTTY: boolean
  }
}

class RuntimeOps implements RuntimeCapabilities {
  // Environment detection - evaluated once
  readonly isBrowser = typeof globalThis !== 'undefined' && 'window' in globalThis && 'document' in globalThis
  readonly isNode = typeof process !== 'undefined' && process.versions?.node !== undefined
  readonly isDeno = typeof (globalThis as any).Deno !== 'undefined'
  readonly isBun = typeof (globalThis as any).Bun !== 'undefined'
  
  // Capability checking
  canExit(): boolean {
    return this.isNode || this.isDeno || this.isBun
  }
  
  canReadEnv(): boolean {
    return this.isNode || this.isDeno || this.isBun
  }
  
  canWriteEnv(): boolean {
    return this.isNode || this.isDeno || this.isBun
  }
  
  canFileSystem(): boolean {
    return this.isNode || this.isDeno || this.isBun
  }
  
  canNetwork(): boolean {
    return true // All environments can do network requests
  }
  
  canCrypto(): boolean {
    return typeof crypto !== 'undefined'
  }
  
  // Platform-agnostic operations
  exit(code: number): never {
    if (this.isNode) {
      process.exit(code)
    } else if (this.isDeno) {
      (globalThis as any).Deno.exit(code)
    } else if (this.isBun) {
      process.exit(code)
    }
    // In browser, we can't exit but we can throw
    const error = new Error(`Process exited with code ${code}`)
    ;(error as any).exitCode = code
    throw error
  }
  
  env(key: string): string | undefined {
    if (this.isNode || this.isBun) {
      return process.env[key]
    } else if (this.isDeno) {
      return (globalThis as any).Deno.env.get(key)
    } else if (this.isBrowser) {
      // In browser, check if env was injected by bundler
      if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
        const win = (globalThis as any).window
        const injected = win.__ENV__ || win.process?.env
        return injected?.[key]
      }
    }
    return undefined
  }
  
  setEnv(key: string, value: string): void {
    if (this.isNode || this.isBun) {
      process.env[key] = value
    } else if (this.isDeno) {
      (globalThis as any).Deno.env.set(key, value)
    } else if (this.isBrowser) {
      // In browser, set on injected env object if available
      if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
        const win = (globalThis as any).window
        if (!win.__ENV__) {
          win.__ENV__ = {}
        }
        win.__ENV__[key] = value
      }
    }
  }
  
  deleteEnv(key: string): void {
    if (this.isNode || this.isBun) {
      delete process.env[key]
    } else if (this.isDeno) {
      (globalThis as any).Deno.env.delete(key)
    } else if (this.isBrowser) {
      if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
        const win = (globalThis as any).window
        const injected = win.__ENV__ || win.process?.env
        if (injected) delete injected[key]
      }
    }
  }
  
  hasEnv(key: string): boolean {
    if (this.isNode || this.isBun) {
      return key in process.env
    } else if (this.isDeno) {
      return (globalThis as any).Deno.env.has(key)
    } else if (this.isBrowser) {
      if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
        const win = (globalThis as any).window
        const injected = win.__ENV__ || win.process?.env
        return injected ? key in injected : false
      }
    }
    return false
  }
  
  allEnv(): Record<string, string> {
    if (this.isNode || this.isBun) {
      return { ...process.env } as Record<string, string>
    } else if (this.isDeno) {
      return { ...(globalThis as any).Deno.env.toObject() }
    } else if (this.isBrowser) {
      if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
        const win = (globalThis as any).window
        const injected = win.__ENV__ || win.process?.env
        return injected ? { ...injected } : {}
      }
    }
    return {}
  }
  
  cwd(): string {
    if (this.isNode || this.isBun) {
      return process.cwd()
    } else if (this.isDeno) {
      return (globalThis as any).Deno.cwd()
    } else {
      return '/' // Default for browser
    }
  }
  
  get stdout() {
    return {
      write: (message: string) => {
        if (this.isNode || this.isBun) {
          process.stdout.write(message)
        } else if (this.isDeno) {
          (globalThis as any).Deno.stdout.writeSync(new TextEncoder().encode(message))
        } else {
          console.log(message)
        }
      },
      isTTY: this.isNode ? Boolean(process.stdout?.isTTY) : 
             this.isDeno ? (globalThis as any).Deno.isatty?.(1) ?? false :
             false
    }
  }
  
  get stderr() {
    return {
      write: (message: string) => {
        if (this.isNode || this.isBun) {
          process.stderr.write(message)
        } else if (this.isDeno) {
          (globalThis as any).Deno.stderr.writeSync(new TextEncoder().encode(message))
        } else {
          console.error(message)
        }
      },
      isTTY: this.isNode ? Boolean(process.stderr?.isTTY) :
             this.isDeno ? (globalThis as any).Deno.isatty?.(2) ?? false :
             false
    }
  }
}

// Export singleton instance
export const runtime = new RuntimeOps()

// Export type for extension
export type { RuntimeCapabilities }

// Helper to assert capability with helpful error
export function requireCapability(capability: keyof RuntimeCapabilities, operation: string): void {
  const can = typeof runtime[capability] === 'function' ? (runtime[capability] as any)() : runtime[capability]
  if (!can) {
    const env = runtime.isBrowser ? 'browser' : 
                runtime.isNode ? 'Node.js' :
                runtime.isDeno ? 'Deno' :
                runtime.isBun ? 'Bun' : 'unknown'
    throw new Error(`${operation} is not available in ${env} environment`)
  }
}