/**
 * Runtime detection and capability checking primitive.
 * This is the foundation for all environment-specific behavior.
 *
 * All utilities should use this module instead of directly checking
 * for process, window, Deno, etc.
 */

// Ambient declarations for the runtime globals we touch. Declared here
// (not as `@types/deno` / `@types/bun` / `lib.dom` deps) so we only
// describe what we actually call and pull no extra dependencies.
declare global {
	// `var` makes the binding live on `globalThis` per ECMAScript spec.
	// We declare a minimal `BrowserWindow` rather than pulling lib.dom
	// — we only touch two custom fields injected by bundlers.
	// eslint-disable-next-line no-var
	var Deno: DenoNamespace | undefined;
	// eslint-disable-next-line no-var
	var Bun: object | undefined;
	// eslint-disable-next-line no-var
	var window: BrowserWindow | undefined;
}

interface BrowserWindow {
	__ENV__?: Record<string, string>;
	process?: { env?: Record<string, string> };
}

interface DenoNamespace {
	exit(code?: number): never;
	cwd(): string;
	env: {
		get(key: string): string | undefined;
		set(key: string, value: string): void;
		delete(key: string): void;
		has(key: string): boolean;
		toObject(): Record<string, string>;
	};
	stdout: { writeSync(data: Uint8Array): number };
	stderr: { writeSync(data: Uint8Array): number };
	isatty(rid: number): boolean;
}

/**
 * Thrown by `runtime.exit(code)` in environments without process exit
 * (i.e. browsers). Carries the requested exit code on `.exitCode` so
 * outer error handlers can still report it.
 */
export class ProcessExitError extends Error {
	readonly exitCode: number;
	constructor(code: number) {
		super(`Process exited with code ${code}`);
		this.name = "ProcessExitError";
		this.exitCode = code;
	}
}

interface RuntimeCapabilities {
	// Environment detection
	readonly isBrowser: boolean;
	readonly isNode: boolean;
	readonly isDeno: boolean;
	readonly isBun: boolean;

	// Capability checking
	canExit(): boolean;
	canReadEnv(): boolean;
	canWriteEnv(): boolean;
	canFileSystem(): boolean;
	canNetwork(): boolean;
	canCrypto(): boolean;

	// Platform-agnostic operations
	exit(code: number): never;
	env(key: string): string | undefined;
	setEnv(key: string, value: string): void;
	deleteEnv(key: string): void;
	hasEnv(key: string): boolean;
	allEnv(): Record<string, string>;
	cwd(): string;
	stdout: {
		write(message: string): void;
		isTTY: boolean;
	};
	stderr: {
		write(message: string): void;
		isTTY: boolean;
	};
}

// Capture the browser window once, if present. Local capture keeps
// every subsequent access typed without re-checking `globalThis.window`.
const browserWindow: BrowserWindow | undefined = globalThis.window;

const browserEnv = (): Record<string, string> | undefined =>
	browserWindow?.__ENV__ ?? browserWindow?.process?.env;

class RuntimeOps implements RuntimeCapabilities {
	// Environment detection - evaluated once
	readonly isBrowser =
		typeof globalThis !== "undefined" &&
		"window" in globalThis &&
		"document" in globalThis;
	readonly isNode =
		typeof process !== "undefined" && process.versions?.node !== undefined;
	readonly isDeno = typeof globalThis.Deno !== "undefined";
	readonly isBun = typeof globalThis.Bun !== "undefined";

	// Capability checking
	canExit(): boolean {
		return this.isNode || this.isDeno || this.isBun;
	}

	canReadEnv(): boolean {
		return this.isNode || this.isDeno || this.isBun;
	}

	canWriteEnv(): boolean {
		return this.isNode || this.isDeno || this.isBun;
	}

	canFileSystem(): boolean {
		return this.isNode || this.isDeno || this.isBun;
	}

	canNetwork(): boolean {
		return true; // All environments can do network requests
	}

	canCrypto(): boolean {
		return typeof crypto !== "undefined";
	}

	// Platform-agnostic operations
	exit(code: number): never {
		if (this.isNode || this.isBun) process.exit(code);
		const Deno = globalThis.Deno;
		if (Deno) Deno.exit(code);
		// Browser / unknown: no process to exit, so surface via a typed
		// error the caller can choose to ignore or propagate.
		throw new ProcessExitError(code);
	}

	env(key: string): string | undefined {
		if (this.isNode || this.isBun) return process.env[key];
		const Deno = globalThis.Deno;
		if (Deno) return Deno.env.get(key);
		return browserEnv()?.[key];
	}

	setEnv(key: string, value: string): void {
		if (this.isNode || this.isBun) {
			process.env[key] = value;
			return;
		}
		const Deno = globalThis.Deno;
		if (Deno) {
			Deno.env.set(key, value);
			return;
		}
		if (browserWindow) {
			const env = browserWindow.__ENV__ ?? {};
			env[key] = value;
			browserWindow.__ENV__ = env;
		}
	}

	deleteEnv(key: string): void {
		if (this.isNode || this.isBun) {
			delete process.env[key];
			return;
		}
		const Deno = globalThis.Deno;
		if (Deno) {
			Deno.env.delete(key);
			return;
		}
		const env = browserEnv();
		if (env) delete env[key];
	}

	hasEnv(key: string): boolean {
		if (this.isNode || this.isBun) return key in process.env;
		const Deno = globalThis.Deno;
		if (Deno) return Deno.env.has(key);
		const env = browserEnv();
		return env ? key in env : false;
	}

	allEnv(): Record<string, string> {
		if (this.isNode || this.isBun)
			return { ...process.env } as Record<string, string>;
		const Deno = globalThis.Deno;
		if (Deno) return { ...Deno.env.toObject() };
		const env = browserEnv();
		return env ? { ...env } : {};
	}

	cwd(): string {
		if (this.isNode || this.isBun) return process.cwd();
		const Deno = globalThis.Deno;
		if (Deno) return Deno.cwd();
		return "/"; // Default for browser
	}

	get stdout() {
		const isNodeLike = this.isNode || this.isBun;
		const Deno = globalThis.Deno;
		return {
			write: (message: string) => {
				if (isNodeLike) {
					process.stdout.write(message);
					return;
				}
				if (Deno) {
					Deno.stdout.writeSync(new TextEncoder().encode(message));
					return;
				}
				console.log(message);
			},
			isTTY: isNodeLike
				? Boolean(process.stdout?.isTTY)
				: (Deno?.isatty?.(1) ?? false),
		};
	}

	get stderr() {
		const isNodeLike = this.isNode || this.isBun;
		const Deno = globalThis.Deno;
		return {
			write: (message: string) => {
				if (isNodeLike) {
					process.stderr.write(message);
					return;
				}
				if (Deno) {
					Deno.stderr.writeSync(new TextEncoder().encode(message));
					return;
				}
				console.error(message);
			},
			isTTY: isNodeLike
				? Boolean(process.stderr?.isTTY)
				: (Deno?.isatty?.(2) ?? false),
		};
	}
}

// Export singleton instance
export const runtime = new RuntimeOps();

// Export type for extension
export type { RuntimeCapabilities };

// Narrow to the boolean-valued capability keys: detection flags and
// `can*()` predicates. Excludes operations like `exit` / `env`.
type CapabilityKey = {
	[K in keyof RuntimeCapabilities]: RuntimeCapabilities[K] extends boolean
		? K
		: RuntimeCapabilities[K] extends () => boolean
			? K
			: never;
}[keyof RuntimeCapabilities];

// Helper to assert capability with helpful error
export function requireCapability(
	capability: CapabilityKey,
	operation: string,
): void {
	const value = runtime[capability];
	const can = typeof value === "function" ? value.call(runtime) : value;
	if (!can) {
		const env = runtime.isBrowser
			? "browser"
			: runtime.isNode
				? "Node.js"
				: runtime.isDeno
					? "Deno"
					: runtime.isBun
						? "Bun"
						: "unknown";
		throw new Error(`${operation} is not available in ${env} environment`);
	}
}
