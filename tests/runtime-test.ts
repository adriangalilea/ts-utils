/**
 * Test runtime detection and platform-specific behavior
 */

import { runtime, log, format, offensive, file, dir, path, kev } from '../src/index.js'

console.log('\n=== Runtime Detection ===\n')

// Show current runtime environment
log.info('Runtime Environment:')
console.log('  Node.js:', runtime.isNode)
console.log('  Browser:', runtime.isBrowser)
console.log('  Deno:', runtime.isDeno)
console.log('  Bun:', runtime.isBun)

console.log('\nCapabilities:')
console.log('  Can exit:', runtime.canExit())
console.log('  Can read env:', runtime.canReadEnv())
console.log('  Can write env:', runtime.canWriteEnv())
console.log('  Can access filesystem:', runtime.canFileSystem())
console.log('  Can network:', runtime.canNetwork())
console.log('  Can crypto:', runtime.canCrypto())

console.log('\n=== Universal Utilities (work everywhere) ===\n')

// These work in any environment
log.success('Log works everywhere')
console.log('Format USD:', format.usd(1234.56))
console.log('Format BTC:', format.btc(0.001))

console.log('\n=== Platform-Specific Utilities ===\n')

if (runtime.canFileSystem()) {
  log.info('File system is available - testing platform utilities:')
  
  // These only work in Node/Deno/Bun
  console.log('  Current directory:', path.cwd())
  console.log('  Test file exists:', file.exists('./package.json'))
  console.log('  Project root:', path.dirname(path.cwd()))
  
  // Test KEV
  kev.set('TEST_VAR', 'hello from test')
  console.log('  KEV test:', kev.get('TEST_VAR'))
} else {
  log.warn('File system not available - platform utilities would throw errors')
  log.info('In a browser, importing from @adriangalilea/utils/browser avoids these')
}

console.log('\n=== Offensive Programming (adapts to environment) ===\n')

// Test how panic behaves in different environments
try {
  log.info('Testing panic behavior...')
  // Uncomment to test - will exit in Node or throw in browser
  // offensive.panic('This is a test panic!')
  log.info('Panic would exit process in Node or throw in browser')
} catch (e: any) {
  log.warn('Caught panic in browser:', e.message)
  if (e.exitCode) {
    console.log('  Exit code:', e.exitCode)
  }
}

console.log('\n=== Environment Variables ===\n')

// Test env operations
runtime.setEnv('TEST_ENV', 'test value')
console.log('Set TEST_ENV:', runtime.env('TEST_ENV'))
console.log('Has TEST_ENV:', runtime.hasEnv('TEST_ENV'))
runtime.deleteEnv('TEST_ENV')
console.log('After delete:', runtime.env('TEST_ENV'))

// Show some env vars
const allEnv = runtime.allEnv()
const envCount = Object.keys(allEnv).length
console.log(`Total environment variables: ${envCount}`)

console.log('\n✨ Runtime test complete!')