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
} as const

// Detect if colors should be enabled
const isColorEnabled = (): boolean => {
  const env = process.env
  if (env.NO_COLOR) return false
  if (env.FORCE_COLOR) return true
  return process.stdout?.isTTY && !env.CI && env.TERM !== 'dumb'
}

const colorEnabled = isColorEnabled()

// Color formatter function
const formatter = (open: string, close = ANSI.reset) => {
  if (!colorEnabled) return (str: string) => str
  return (str: string) => `${open}${str}${close}`
}

// Text styling functions
export const bold = formatter(ANSI.bold)
export const dim = formatter(ANSI.dim)
export const red = formatter(ANSI.red)
export const green = formatter(ANSI.green)
export const yellow = formatter(ANSI.yellow)
export const blue = formatter(ANSI.blue)
export const magenta = formatter(ANSI.magenta)
export const cyan = formatter(ANSI.cyan)
export const white = formatter(ANSI.white)
export const gray = formatter(ANSI.gray)
export const purple = formatter(ANSI.purple)

// Background colors
export const bgRed = formatter(ANSI.bgRed)
export const bgGreen = formatter(ANSI.bgGreen)
export const bgYellow = formatter(ANSI.bgYellow)
export const bgBlue = formatter(ANSI.bgBlue)
export const bgMagenta = formatter(ANSI.bgMagenta)
export const bgCyan = formatter(ANSI.bgCyan)
export const bgWhite = formatter(ANSI.bgWhite)

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
} as const

type LogLevel = keyof typeof prefixes

// Log level priority (lower number = higher priority)
const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  ready: 2,
  success: 2,
  event: 2,
  wait: 3,
  trace: 4,
} as const

// Get current log level from environment
function getCurrentLogLevel(): number {
  const level = process.env.LOG_LEVEL?.toLowerCase()
  if (!level) return LOG_LEVELS.info // Default to info
  
  switch (level) {
    case 'error': return LOG_LEVELS.error
    case 'warn': return LOG_LEVELS.warn
    case 'info': return LOG_LEVELS.info
    case 'debug':
    case 'trace': return LOG_LEVELS.trace
    default: return LOG_LEVELS.info
  }
}

const currentLogLevel = getCurrentLogLevel()

// LRU Cache for warn-once functionality
class LRUCache<K, V> {
  private cache = new Map<K, V>()
  private maxSize: number

  constructor(maxSize: number) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const item = this.cache.get(key)
    if (item !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key)
      this.cache.set(key, item)
    }
    return item
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }
    this.cache.set(key, value)
    
    if (this.cache.size > this.maxSize) {
      // Remove least recently used (first item)
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }
}

const warnOnceCache = new LRUCache<string, boolean>(10_000)

// Core logging function
function prefixedLog(level: LogLevel, ...messages: any[]): void {
  // Check if this log level should be displayed
  const levelPriority = LOG_LEVELS[level as keyof typeof LOG_LEVELS] ?? LOG_LEVELS.info
  if (levelPriority > currentLogLevel) {
    return // Skip this log
  }
  
  // Remove empty first message
  if ((messages[0] === '' || messages[0] === undefined) && messages.length === 1) {
    messages.shift()
  }

  // Determine console method based on level
  const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
  const prefix = prefixes[level]

  // Handle empty messages
  if (messages.length === 0) {
    console[consoleMethod]('')
    return
  }

  // Format and log the message
  if (messages.length === 1 && typeof messages[0] === 'string') {
    console[consoleMethod](` ${prefix} ${messages[0]}`)
  } else {
    console[consoleMethod](` ${prefix}`, ...messages)
  }
}

// Bootstrap function for startup messages (no prefix, just indentation)
export function bootstrap(...messages: string[]): void {
  console.log('   ' + messages.join(' '))
}

// Main logging functions
export function wait(...messages: any[]): void {
  prefixedLog('wait', ...messages)
}

export function error(...messages: any[]): void {
  prefixedLog('error', ...messages)
}

export function warn(...messages: any[]): void {
  prefixedLog('warn', ...messages)
}

export function ready(...messages: any[]): void {
  prefixedLog('ready', ...messages)
}

export function info(...messages: any[]): void {
  prefixedLog('info', ...messages)
}

export function success(...messages: any[]): void {
  prefixedLog('success', ...messages)
}

export function event(...messages: any[]): void {
  prefixedLog('event', ...messages)
}

export function trace(...messages: any[]): void {
  prefixedLog('trace', ...messages)
}

// Special warn-once function
export function warnOnce(...messages: any[]): void {
  const key = messages.join(' ')
  if (!warnOnceCache.has(key)) {
    warnOnceCache.set(key, true)
    warn(...messages)
  }
}

// Timer functionality for measuring durations
const timers = new Map<string, number>()

export function time(label: string): void {
  timers.set(label, Date.now())
}

export function timeEnd(label: string): void {
  const start = timers.get(label)
  if (start === undefined) {
    warn(`Timer '${label}' does not exist`)
    return
  }
  
  const duration = Date.now() - start
  timers.delete(label)
  
  const formatted = duration > 10000 
    ? `${Math.round(duration / 100) / 10}s`
    : `${Math.round(duration)}ms`
  
  trace(`${label}: ${formatted}`)
}

// Utility function to create a prefixed logger instance
export function createLogger(prefix: string) {
  return {
    wait: (...messages: any[]) => wait(`[${prefix}]`, ...messages),
    error: (...messages: any[]) => error(`[${prefix}]`, ...messages),
    warn: (...messages: any[]) => warn(`[${prefix}]`, ...messages),
    ready: (...messages: any[]) => ready(`[${prefix}]`, ...messages),
    info: (...messages: any[]) => info(`[${prefix}]`, ...messages),
    success: (...messages: any[]) => success(`[${prefix}]`, ...messages),
    event: (...messages: any[]) => event(`[${prefix}]`, ...messages),
    trace: (...messages: any[]) => trace(`[${prefix}]`, ...messages),
    warnOnce: (...messages: any[]) => warnOnce(`[${prefix}]`, ...messages),
    time: (label: string) => time(`${prefix}:${label}`),
    timeEnd: (label: string) => timeEnd(`${prefix}:${label}`),
  }
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
}

export { log }

// Example usage helper
export function logAppStartup(options: {
  name: string
  version: string
  port: number
  host?: string
  environment?: string
}): void {
  const { name, version, port, host = 'localhost', environment } = options
  
  bootstrap(bold(purple(`▶ ${name} ${version}`)))
  bootstrap(`- Local:        http://${host}:${port}`)
  
  if (host !== 'localhost') {
    bootstrap(`- Network:      http://${getNetworkAddress()}:${port}`)
  }
  
  if (environment) {
    bootstrap(`- Environment:  ${environment}`)
  }
  
  info('')
}

// Helper to get network address
function getNetworkAddress(): string {
  const os = require('os')
  const interfaces = os.networkInterfaces()
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]!) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  
  return 'localhost'
}