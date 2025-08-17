/**
 * Runtime detection and capability checking primitive.
 * This is the foundation for all environment-specific behavior.
 *
 * All utilities should use this module instead of directly checking
 * for process, window, Deno, etc.
 */
class RuntimeOps {
    // Environment detection - evaluated once
    isBrowser = typeof globalThis !== 'undefined' && 'window' in globalThis && 'document' in globalThis;
    isNode = typeof process !== 'undefined' && process.versions?.node !== undefined;
    isDeno = typeof globalThis.Deno !== 'undefined';
    isBun = typeof globalThis.Bun !== 'undefined';
    // Capability checking
    canExit() {
        return this.isNode || this.isDeno || this.isBun;
    }
    canReadEnv() {
        return this.isNode || this.isDeno || this.isBun;
    }
    canWriteEnv() {
        return this.isNode || this.isDeno || this.isBun;
    }
    canFileSystem() {
        return this.isNode || this.isDeno || this.isBun;
    }
    canNetwork() {
        return true; // All environments can do network requests
    }
    canCrypto() {
        return typeof crypto !== 'undefined';
    }
    // Platform-agnostic operations
    exit(code) {
        if (this.isNode) {
            process.exit(code);
        }
        else if (this.isDeno) {
            globalThis.Deno.exit(code);
        }
        else if (this.isBun) {
            process.exit(code);
        }
        // In browser, we can't exit but we can throw
        const error = new Error(`Process exited with code ${code}`);
        error.exitCode = code;
        throw error;
    }
    env(key) {
        if (this.isNode || this.isBun) {
            return process.env[key];
        }
        else if (this.isDeno) {
            return globalThis.Deno.env.get(key);
        }
        else if (this.isBrowser) {
            // In browser, check if env was injected by bundler
            if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
                const win = globalThis.window;
                const injected = win.__ENV__ || win.process?.env;
                return injected?.[key];
            }
        }
        return undefined;
    }
    setEnv(key, value) {
        if (this.isNode || this.isBun) {
            process.env[key] = value;
        }
        else if (this.isDeno) {
            globalThis.Deno.env.set(key, value);
        }
        else if (this.isBrowser) {
            // In browser, set on injected env object if available
            if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
                const win = globalThis.window;
                if (!win.__ENV__) {
                    win.__ENV__ = {};
                }
                win.__ENV__[key] = value;
            }
        }
    }
    deleteEnv(key) {
        if (this.isNode || this.isBun) {
            delete process.env[key];
        }
        else if (this.isDeno) {
            globalThis.Deno.env.delete(key);
        }
        else if (this.isBrowser) {
            if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
                const win = globalThis.window;
                const injected = win.__ENV__ || win.process?.env;
                if (injected)
                    delete injected[key];
            }
        }
    }
    hasEnv(key) {
        if (this.isNode || this.isBun) {
            return key in process.env;
        }
        else if (this.isDeno) {
            return globalThis.Deno.env.has(key);
        }
        else if (this.isBrowser) {
            if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
                const win = globalThis.window;
                const injected = win.__ENV__ || win.process?.env;
                return injected ? key in injected : false;
            }
        }
        return false;
    }
    allEnv() {
        if (this.isNode || this.isBun) {
            return { ...process.env };
        }
        else if (this.isDeno) {
            return { ...globalThis.Deno.env.toObject() };
        }
        else if (this.isBrowser) {
            if (typeof globalThis !== 'undefined' && 'window' in globalThis) {
                const win = globalThis.window;
                const injected = win.__ENV__ || win.process?.env;
                return injected ? { ...injected } : {};
            }
        }
        return {};
    }
    cwd() {
        if (this.isNode || this.isBun) {
            return process.cwd();
        }
        else if (this.isDeno) {
            return globalThis.Deno.cwd();
        }
        else {
            return '/'; // Default for browser
        }
    }
    get stdout() {
        return {
            write: (message) => {
                if (this.isNode || this.isBun) {
                    process.stdout.write(message);
                }
                else if (this.isDeno) {
                    globalThis.Deno.stdout.writeSync(new TextEncoder().encode(message));
                }
                else {
                    console.log(message);
                }
            },
            isTTY: this.isNode ? Boolean(process.stdout?.isTTY) :
                this.isDeno ? globalThis.Deno.isatty?.(1) ?? false :
                    false
        };
    }
    get stderr() {
        return {
            write: (message) => {
                if (this.isNode || this.isBun) {
                    process.stderr.write(message);
                }
                else if (this.isDeno) {
                    globalThis.Deno.stderr.writeSync(new TextEncoder().encode(message));
                }
                else {
                    console.error(message);
                }
            },
            isTTY: this.isNode ? Boolean(process.stderr?.isTTY) :
                this.isDeno ? globalThis.Deno.isatty?.(2) ?? false :
                    false
        };
    }
}
// Export singleton instance
export const runtime = new RuntimeOps();
// Helper to assert capability with helpful error
export function requireCapability(capability, operation) {
    const can = typeof runtime[capability] === 'function' ? runtime[capability]() : runtime[capability];
    if (!can) {
        const env = runtime.isBrowser ? 'browser' :
            runtime.isNode ? 'Node.js' :
                runtime.isDeno ? 'Deno' :
                    runtime.isBun ? 'Bun' : 'unknown';
        throw new Error(`${operation} is not available in ${env} environment`);
    }
}
//# sourceMappingURL=runtime.js.map