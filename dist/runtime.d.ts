/**
 * Runtime detection and capability checking primitive.
 * This is the foundation for all environment-specific behavior.
 *
 * All utilities should use this module instead of directly checking
 * for process, window, Deno, etc.
 */
interface RuntimeCapabilities {
    readonly isBrowser: boolean;
    readonly isNode: boolean;
    readonly isDeno: boolean;
    readonly isBun: boolean;
    canExit(): boolean;
    canReadEnv(): boolean;
    canWriteEnv(): boolean;
    canFileSystem(): boolean;
    canNetwork(): boolean;
    canCrypto(): boolean;
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
declare class RuntimeOps implements RuntimeCapabilities {
    readonly isBrowser: boolean;
    readonly isNode: boolean;
    readonly isDeno: boolean;
    readonly isBun: boolean;
    canExit(): boolean;
    canReadEnv(): boolean;
    canWriteEnv(): boolean;
    canFileSystem(): boolean;
    canNetwork(): boolean;
    canCrypto(): boolean;
    exit(code: number): never;
    env(key: string): string | undefined;
    setEnv(key: string, value: string): void;
    deleteEnv(key: string): void;
    hasEnv(key: string): boolean;
    allEnv(): Record<string, string>;
    cwd(): string;
    get stdout(): {
        write: (message: string) => void;
        isTTY: any;
    };
    get stderr(): {
        write: (message: string) => void;
        isTTY: any;
    };
}
export declare const runtime: RuntimeOps;
export type { RuntimeCapabilities };
export declare function requireCapability(capability: keyof RuntimeCapabilities, operation: string): void;
//# sourceMappingURL=runtime.d.ts.map