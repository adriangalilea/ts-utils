/**
 * A Next.js-style logger for TypeScript applications
 * Provides colored output with Unicode symbols for different log levels
 */
export declare const bold: (str: string) => string;
export declare const dim: (str: string) => string;
export declare const red: (str: string) => string;
export declare const green: (str: string) => string;
export declare const yellow: (str: string) => string;
export declare const blue: (str: string) => string;
export declare const magenta: (str: string) => string;
export declare const cyan: (str: string) => string;
export declare const white: (str: string) => string;
export declare const gray: (str: string) => string;
export declare const purple: (str: string) => string;
export declare const bgRed: (str: string) => string;
export declare const bgGreen: (str: string) => string;
export declare const bgYellow: (str: string) => string;
export declare const bgBlue: (str: string) => string;
export declare const bgMagenta: (str: string) => string;
export declare const bgCyan: (str: string) => string;
export declare const bgWhite: (str: string) => string;
export declare function bootstrap(...messages: string[]): void;
export declare function wait(...messages: any[]): void;
export declare function error(...messages: any[]): void;
export declare function warn(...messages: any[]): void;
export declare function ready(...messages: any[]): void;
export declare function info(...messages: any[]): void;
export declare function success(...messages: any[]): void;
export declare function event(...messages: any[]): void;
export declare function trace(...messages: any[]): void;
export declare function warnOnce(...messages: any[]): void;
export declare function time(label: string): void;
export declare function timeEnd(label: string): void;
export declare function createLogger(prefix: string): {
    wait: (...messages: any[]) => void;
    error: (...messages: any[]) => void;
    warn: (...messages: any[]) => void;
    ready: (...messages: any[]) => void;
    info: (...messages: any[]) => void;
    success: (...messages: any[]) => void;
    event: (...messages: any[]) => void;
    trace: (...messages: any[]) => void;
    warnOnce: (...messages: any[]) => void;
    time: (label: string) => void;
    timeEnd: (label: string) => void;
};
declare const log: {
    wait: typeof wait;
    error: typeof error;
    warn: typeof warn;
    ready: typeof ready;
    info: typeof info;
    success: typeof success;
    event: typeof event;
    trace: typeof trace;
    warnOnce: typeof warnOnce;
    time: typeof time;
    timeEnd: typeof timeEnd;
    bootstrap: typeof bootstrap;
    createLogger: typeof createLogger;
    colors: {
        bold: (str: string) => string;
        dim: (str: string) => string;
        red: (str: string) => string;
        green: (str: string) => string;
        yellow: (str: string) => string;
        blue: (str: string) => string;
        magenta: (str: string) => string;
        cyan: (str: string) => string;
        white: (str: string) => string;
        gray: (str: string) => string;
        purple: (str: string) => string;
        bgRed: (str: string) => string;
        bgGreen: (str: string) => string;
        bgYellow: (str: string) => string;
        bgBlue: (str: string) => string;
        bgMagenta: (str: string) => string;
        bgCyan: (str: string) => string;
        bgWhite: (str: string) => string;
    };
};
export { log };
export declare function logAppStartup(options: {
    name: string;
    version: string;
    port: number;
    host?: string;
    environment?: string;
}): void;
//# sourceMappingURL=log.d.ts.map