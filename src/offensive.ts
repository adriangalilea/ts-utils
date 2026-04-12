/**
 * Offensive programming primitives + typed boundary errors.
 *
 * "A confused program SHOULD scream." — John Carmack
 *
 * Throw, always. An uncaught Panic crashes the process with a full stack trace.
 * Zero dependencies. Works identically in Node, Deno, Bun, and browsers.
 *
 * Fail-fast primitives (throw Panic — bugs in us):
 *   assert(cond, ...msg)          invariant checking, narrows types via `asserts`
 *   panic(...msg)                 impossible state reached
 *   assertNever(value, ...msg)    exhaustiveness check — compile error on missed cases
 *   must(() => expr)              unwrap-or-die for operations (sync + async)
 *   unwrap(value, ...msg)         unwrap nullable T | null | undefined → T
 *
 * Typed boundary errors (throw SourcedError — the external system failed):
 *   SourcedError                  typed error with source/operation/status/context
 *   isSourcedError(e, source?)    type guard for catch-site narrowing
 *
 * Panics are bugs. SourcedErrors are boundary failures. Keep them separate at
 * catch boundaries:
 *
 *   try { await doWork() }
 *   catch (e) {
 *     if (e instanceof Panic) throw e            // bug in us — crash
 *     if (isSourcedError(e, 'stripe')) { ... }   // stripe failed — handle
 *     throw e                                    // unknown — re-throw
 *   }
 */

/**
 * Distinct error class for offensive programming failures.
 * Distinguishes bugs from runtime errors at catch boundaries.
 *
 * @example
 * // In a server — let Panics crash, handle everything else
 * app.use((err, req, res, next) => {
 *   if (err instanceof Panic) throw err  // bug, re-throw, let it crash
 *   res.status(500).json({ error: 'internal error' })
 * })
 *
 * // In tests — assert that code panics
 * expect(() => assert(false, 'boom')).toThrow(Panic)
 */
export class Panic extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Panic'
  }
}

/**
 * Assert throws if condition is false. Narrows types via `asserts condition`.
 *
 * @example
 * assert(data.length > 0, 'empty packet')
 * assert(port > 0 && port < 65536, 'invalid port:', port)
 */
export function assert(condition: boolean, ...msg: any[]): asserts condition {
  if (!condition) throw new Panic(msg.join(' ') || 'assertion failed')
}

/**
 * Panic throws immediately. Use when the program reaches an impossible state.
 *
 * @example
 * switch (state) {
 *   case 'ready': handleReady(); break
 *   case 'loading': handleLoading(); break
 *   default: panic('impossible state:', state)
 * }
 */
export function panic(...msg: any[]): never {
  throw new Panic(msg.join(' ') || 'panic')
}

/**
 * Exhaustiveness check — compile error if a switch/if misses a case.
 * The `never` type means TS won't let you call this if all cases are handled.
 * Add a new variant to a union → every assertNever site lights up at compile time.
 *
 * @example
 * type Event = { kind: 'click' } | { kind: 'hover' } | { kind: 'scroll' }
 * function handle(e: Event) {
 *   switch (e.kind) {
 *     case 'click': return handleClick()
 *     case 'hover': return handleHover()
 *     // forgot 'scroll' → TS error: Argument of type '{ kind: "scroll" }' not assignable to 'never'
 *     default: assertNever(e)
 *   }
 * }
 */
export function assertNever(value: never, ...msg: any[]): never {
  throw new Panic(msg.join(' ') || `assertNever: unexpected value: ${JSON.stringify(value)}`)
}

/**
 * Must unwraps an operation that should never fail. Handles sync and async.
 *
 * @example
 * const data = must(() => JSON.parse(staticJsonString))
 * const file = await must(() => fs.promises.readFile(path))
 * const buf = must(() => readFileSync(path))
 */
export function must<T>(fn: () => Promise<T>): Promise<T>
export function must<T>(fn: () => T): T
export function must<T>(fn: () => T | Promise<T>): T | Promise<T> {
  try {
    const result = fn()
    if (result instanceof Promise) {
      return result.catch(e => {
        throw new Panic(e instanceof Error ? e.message : String(e))
      })
    }
    return result
  } catch (e) {
    throw new Panic(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Unwrap a nullable value or throw. Like Rust's .unwrap()/.expect().
 * Returns T from T | null | undefined with type narrowing in one expression.
 *
 * @example
 * // assert needs two statements:
 * const user = db.findUser(id)
 * assert(user !== null, 'user not found:', id)
 *
 * // unwrap does it inline:
 * const user = unwrap(db.findUser(id), 'user not found:', id)
 * const el = unwrap(document.getElementById('app'))
 */
export function unwrap<T>(value: T | null | undefined, ...msg: any[]): T {
  if (value == null) throw new Panic(msg.join(' ') || `unwrap: got ${value}`)
  return value
}

/**
 * Typed error from a named external source with structured context.
 *
 * Raise at boundaries with the messy world (HTTP APIs, databases, external
 * processes). Every SourcedError carries enough context to reconstruct the
 * failure without a debugger.
 *
 * @example
 * try {
 *   return await stripe.charges.create({ customer, amount })
 * } catch (e) {
 *   throw new SourcedError({
 *     source: 'stripe',
 *     operation: 'charge_customer',
 *     message: e instanceof Error ? e.message : String(e),
 *     status: (e as any)?.statusCode,
 *     cause: e,
 *     context: { customer, amount },
 *   })
 * }
 */
export class SourcedError<S extends string = string> extends Error {
  readonly source: S
  readonly operation: string
  readonly status?: number
  readonly context: Record<string, unknown>

  constructor(args: {
    source: S
    operation: string
    message: string
    status?: number
    cause?: unknown
    context?: Record<string, unknown>
  }) {
    const status = args.status != null ? ` status=${args.status}` : ''
    super(`[${args.source}:${args.operation}${status}] ${args.message}`, { cause: args.cause })
    this.name = 'SourcedError'
    this.source = args.source
    this.operation = args.operation
    this.status = args.status
    this.context = args.context ?? {}
  }

  toJSON(): Record<string, unknown> {
    return {
      source: this.source,
      operation: this.operation,
      status: this.status,
      message: this.message,
      context: this.context,
      cause: this.cause instanceof Error ? this.cause.message : this.cause != null ? String(this.cause) : null,
    }
  }
}

/**
 * Type guard for SourcedError. Optionally narrows to a specific source.
 *
 * @example
 * try { await charge(customer, amount) }
 * catch (e) {
 *   if (isSourcedError(e, 'stripe') && e.status === 402) {
 *     // TS knows e.source === 'stripe' here
 *     return 'card declined'
 *   }
 *   throw e
 * }
 */
export function isSourcedError<S extends string>(e: unknown, source?: S): e is SourcedError<S> {
  return e instanceof SourcedError && (source === undefined || e.source === source)
}

export const offensive = {
  Panic,
  assert,
  panic,
  assertNever,
  must,
  unwrap,
  SourcedError,
  isSourcedError,
}
