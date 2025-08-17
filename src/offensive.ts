/**
 * OFFENSIVE PROGRAMMING PRIMITIVES
 *
 * "A confused program SHOULD scream" - John Carmack
 *
 * These utilities are the ANTITHESIS of defensive programming.
 * 
 * Defensive programming: try/catch, error recovery, graceful degradation, silent failures
 * Offensive programming: FAIL LOUD, FAIL FAST, NO RECOVERY, CRASH EARLY
 *
 * We don't handle errors - we make them catastrophic.
 * We don't recover - we crash.
 * We don't validate and continue - we assert and panic.
 *
 * This approach makes bugs IMPOSSIBLE to ignore:
 * - Wrong assumptions? CRASH
 * - Invalid state? CRASH  
 * - "Impossible" error? CRASH
 *
 * The only acceptable response to confusion is to scream and die.
 */

/**
 * Assert exits with error if condition is false.
 * Use for validating preconditions and invariants.
 *
 * @example
 * function sendPacket(data: Buffer, port: number) {
 *   assert(data.length > 0, 'empty packet')
 *   assert(port > 0 && port < 65536, 'invalid port:', port)
 *   // Now safe to proceed
 * }
 */
export function assert(condition: boolean, ...msg: any[]): asserts condition {
  if (!condition) {
    const message = msg.length > 0 ? msg.join(' ') : 'assertion failed'
    console.error(`⨯ ${message}`)
    process.exit(1)
  }
}

/**
 * Must unwraps a value that may throw and exits if error occurs.
 * Use for operations that should never fail in correct code.
 *
 * @example
 * const data = must(() => JSON.parse(staticJsonString))
 * const regex = must(() => new RegExp('^\\d+$'))
 */
export function must<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    console.error(`⨯ ${error}`)
    process.exit(1)
  }
}

/**
 * Check exits cleanly with formatted error message if error is not null/undefined.
 * Use for expected errors: file not found, network issues, permissions, etc.
 *
 * @example
 * try {
 *   const data = await fs.readFile(userFile)
 * } catch (err) {
 *   check(err) // exits with error message
 * }
 */
export function check(err: any, ...messages: string[]): void {
  if (err) {
    if (messages.length > 0) {
      console.error(`⨯ ${messages.join(' ')}`)
    } else {
      console.error(`⨯ ${err}`)
    }
    process.exit(1)
  }
}

/**
 * Panic immediately exits with error message.
 * Use when the program reaches an impossible state.
 *
 * @example
 * switch (state) {
 *   case 'ready': handleReady(); break
 *   case 'loading': handleLoading(); break
 *   default: panic('impossible state:', state)
 * }
 */
export function panic(...msg: any[]): never {
  const message = msg.length > 0 ? msg.join(' ') : 'panic'
  console.error(`⨯ ${message}`)
  process.exit(1)
}

export const offensive = {
  assert,
  must,
  check,
  panic,
}

export default offensive