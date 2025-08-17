/**
 * A Next.js-style logger for TypeScript applications
 * Provides colored output with Unicode symbols for different log levels
 */
// ANSI escape codes for colors
const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    // Foreground colors
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    // Custom purple (Next.js style)
    purple: '\x1b[38;2;173;127;168m',
    // Background colors
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m',
};
// Detect if colors should be enabled
const isColorEnabled = () => {
    const env = process.env;
    if (env.NO_COLOR)
        return false;
    if (env.FORCE_COLOR)
        return true;
    return process.stdout?.isTTY && !env.CI && env.TERM !== 'dumb';
};
const colorEnabled = isColorEnabled();
// Color formatter function
const formatter = (open, close = ANSI.reset) => {
    if (!colorEnabled)
        return (str) => str;
    return (str) => `${open}${str}${close}`;
};
// Text styling functions
export const bold = formatter(ANSI.bold);
export const dim = formatter(ANSI.dim);
export const red = formatter(ANSI.red);
export const green = formatter(ANSI.green);
export const yellow = formatter(ANSI.yellow);
export const blue = formatter(ANSI.blue);
export const magenta = formatter(ANSI.magenta);
export const cyan = formatter(ANSI.cyan);
export const white = formatter(ANSI.white);
export const gray = formatter(ANSI.gray);
export const purple = formatter(ANSI.purple);
// Background colors
export const bgRed = formatter(ANSI.bgRed);
export const bgGreen = formatter(ANSI.bgGreen);
export const bgYellow = formatter(ANSI.bgYellow);
export const bgBlue = formatter(ANSI.bgBlue);
export const bgMagenta = formatter(ANSI.bgMagenta);
export const bgCyan = formatter(ANSI.bgCyan);
export const bgWhite = formatter(ANSI.bgWhite);
// Prefix symbols matching Next.js style
const prefixes = {
    wait: white(bold('○')),
    error: red(bold('⨯')),
    warn: yellow(bold('⚠')),
    ready: '▶',
    info: white(bold(' ')),
    success: green(bold('✓')),
    event: green(bold('✓')),
    trace: magenta(bold('»')),
};
// LRU Cache for warn-once functionality
class LRUCache {
    cache = new Map();
    maxSize;
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    get(key) {
        const item = this.cache.get(key);
        if (item !== undefined) {
            // Move to end (most recently used)
            this.cache.delete(key);
            this.cache.set(key, item);
        }
        return item;
    }
    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        this.cache.set(key, value);
        if (this.cache.size > this.maxSize) {
            // Remove least recently used (first item)
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
    }
    has(key) {
        return this.cache.has(key);
    }
}
const warnOnceCache = new LRUCache(10_000);
// Core logging function
function prefixedLog(level, ...messages) {
    // Remove empty first message
    if ((messages[0] === '' || messages[0] === undefined) && messages.length === 1) {
        messages.shift();
    }
    // Determine console method based on level
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    const prefix = prefixes[level];
    // Handle empty messages
    if (messages.length === 0) {
        console[consoleMethod]('');
        return;
    }
    // Format and log the message
    if (messages.length === 1 && typeof messages[0] === 'string') {
        console[consoleMethod](` ${prefix} ${messages[0]}`);
    }
    else {
        console[consoleMethod](` ${prefix}`, ...messages);
    }
}
// Bootstrap function for startup messages (no prefix, just indentation)
export function bootstrap(...messages) {
    console.log('   ' + messages.join(' '));
}
// Main logging functions
export function wait(...messages) {
    prefixedLog('wait', ...messages);
}
export function error(...messages) {
    prefixedLog('error', ...messages);
}
export function warn(...messages) {
    prefixedLog('warn', ...messages);
}
export function ready(...messages) {
    prefixedLog('ready', ...messages);
}
export function info(...messages) {
    prefixedLog('info', ...messages);
}
export function success(...messages) {
    prefixedLog('success', ...messages);
}
export function event(...messages) {
    prefixedLog('event', ...messages);
}
export function trace(...messages) {
    prefixedLog('trace', ...messages);
}
// Special warn-once function
export function warnOnce(...messages) {
    const key = messages.join(' ');
    if (!warnOnceCache.has(key)) {
        warnOnceCache.set(key, true);
        warn(...messages);
    }
}
// Timer functionality for measuring durations
const timers = new Map();
export function time(label) {
    timers.set(label, Date.now());
}
export function timeEnd(label) {
    const start = timers.get(label);
    if (start === undefined) {
        warn(`Timer '${label}' does not exist`);
        return;
    }
    const duration = Date.now() - start;
    timers.delete(label);
    const formatted = duration > 10000
        ? `${Math.round(duration / 100) / 10}s`
        : `${Math.round(duration)}ms`;
    trace(`${label}: ${formatted}`);
}
// Utility function to create a prefixed logger instance
export function createLogger(prefix) {
    return {
        wait: (...messages) => wait(`[${prefix}]`, ...messages),
        error: (...messages) => error(`[${prefix}]`, ...messages),
        warn: (...messages) => warn(`[${prefix}]`, ...messages),
        ready: (...messages) => ready(`[${prefix}]`, ...messages),
        info: (...messages) => info(`[${prefix}]`, ...messages),
        success: (...messages) => success(`[${prefix}]`, ...messages),
        event: (...messages) => event(`[${prefix}]`, ...messages),
        trace: (...messages) => trace(`[${prefix}]`, ...messages),
        warnOnce: (...messages) => warnOnce(`[${prefix}]`, ...messages),
        time: (label) => time(`${prefix}:${label}`),
        timeEnd: (label) => timeEnd(`${prefix}:${label}`),
    };
}
// Export a default log instance
const log = {
    wait,
    error,
    warn,
    ready,
    info,
    success,
    event,
    trace,
    warnOnce,
    time,
    timeEnd,
    bootstrap,
    createLogger,
    // Color utilities
    colors: {
        bold,
        dim,
        red,
        green,
        yellow,
        blue,
        magenta,
        cyan,
        white,
        gray,
        purple,
        bgRed,
        bgGreen,
        bgYellow,
        bgBlue,
        bgMagenta,
        bgCyan,
        bgWhite,
    },
};
export { log };
// Example usage helper
export function logAppStartup(options) {
    const { name, version, port, host = 'localhost', environment } = options;
    bootstrap(bold(purple(`▶ ${name} ${version}`)));
    bootstrap(`- Local:        http://${host}:${port}`);
    if (host !== 'localhost') {
        bootstrap(`- Network:      http://${getNetworkAddress()}:${port}`);
    }
    if (environment) {
        bootstrap(`- Environment:  ${environment}`);
    }
    info('');
}
// Helper to get network address
function getNetworkAddress() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}
//# sourceMappingURL=log.js.map