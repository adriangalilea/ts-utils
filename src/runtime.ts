/**
 * Runtime detection and capability checking primitive.
 * This is the foundation for all environment-specific behavior.
 *
 * All utilities should use this module instead of directly checking
 * for process, window, Deno, etc.
 */

// We deliberately DO NOT `declare global { var Deno / Bun / window: ... }`.
// Doing so would merge with `@types/deno` / `@types/bun` in downstream
// consumers and clobber their richer types (e.g. erase `Bun.spawn` by
// merging with our `object` placeholder). Instead we read the runtime
// globals through local structural casts on `globalThis` — the type
// surface stays inside this module and never escapes to consumers.

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

const getDeno = (): DenoNamespace | undefined =>
	(globalThis as { Deno?: DenoNamespace }).Deno;

const hasBun = (): boolean =>
	typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

const getBrowserWindow = (): BrowserWindow | undefined =>
	(globalThis as { window?: BrowserWindow }).window;

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
// every subsequent access typed without re-running the structural cast.
const browserWindow = getBrowserWindow();

const browserEnv = (): Record<string, string> | undefined =>
	browserWindow?.__ENV__ ?? browserWindow?.process?.env;

// Methods below repeat `const Deno = getDeno()` per call instead of
// caching it on the instance: TS only narrows `DenoNamespace | undefined`
// → `DenoNamespace` through a local-const + `if` pattern. A class
// field would still be the union at the call sites. Same runtime cost,
// honest types.
class RuntimeOps implements RuntimeCapabilities {
	// Environment detection - evaluated once
	readonly isBrowser =
		typeof globalThis !== "undefined" &&
		"window" in globalThis &&
		"document" in globalThis;
	readonly isNode =
		typeof process !== "undefined" && process.versions?.node !== undefined;
	readonly isDeno = getDeno() !== undefined;
	readonly isBun = hasBun();

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
		const Deno = getDeno();
		if (Deno) Deno.exit(code);
		// Browser / unknown: no process to exit, so surface via a typed
		// error the caller can choose to ignore or propagate.
		throw new ProcessExitError(code);
	}

	env(key: string): string | undefined {
		if (this.isNode || this.isBun) return process.env[key];
		const Deno = getDeno();
		if (Deno) return Deno.env.get(key);
		return browserEnv()?.[key];
	}

	setEnv(key: string, value: string): void {
		if (this.isNode || this.isBun) {
			process.env[key] = value;
			return;
		}
		const Deno = getDeno();
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
		const Deno = getDeno();
		if (Deno) {
			Deno.env.delete(key);
			return;
		}
		const env = browserEnv();
		if (env) delete env[key];
	}

	hasEnv(key: string): boolean {
		if (this.isNode || this.isBun) return key in process.env;
		const Deno = getDeno();
		if (Deno) return Deno.env.has(key);
		const env = browserEnv();
		return env ? key in env : false;
	}

	allEnv(): Record<string, string> {
		if (this.isNode || this.isBun)
			return { ...process.env } as Record<string, string>;
		const Deno = getDeno();
		if (Deno) return { ...Deno.env.toObject() };
		const env = browserEnv();
		return env ? { ...env } : {};
	}

	cwd(): string {
		if (this.isNode || this.isBun) return process.cwd();
		const Deno = getDeno();
		if (Deno) return Deno.cwd();
		return "/"; // Default for browser
	}

	get stdout() {
		const isNodeLike = this.isNode || this.isBun;
		const Deno = getDeno();
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
		const Deno = getDeno();
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
