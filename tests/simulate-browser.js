/**
 * Simulates browser environment to test browser-specific behavior
 */

// Hide Node/process to simulate browser
const originalProcess = global.process
const originalRequire = global.require

// Set up browser-like globals
global.window = {
  document: {},
  __ENV__: {
    BROWSER_VAR: 'from browser'
  }
}
global.document = global.window.document

// Temporarily hide process to test browser detection
global.process = undefined

console.log('\n=== Simulating Browser Environment ===\n')

import('../dist/browser.js').then(utils => {
  const { runtime, log, format, offensive } = utils
  
  console.log('Runtime Detection:')
  console.log('  Browser:', runtime.isBrowser)
  console.log('  Node:', runtime.isNode)
  console.log('  Can exit:', runtime.canExit())
  console.log('  Can filesystem:', runtime.canFileSystem())
  
  console.log('\nUniversal utilities work:')
  log.success('✓ Log works in simulated browser')
  console.log('  Format USD:', format.usd(100))
  
  console.log('\nEnvironment variables:')
  console.log('  BROWSER_VAR:', runtime.env('BROWSER_VAR'))
  runtime.setEnv('TEST', 'browser test')
  console.log('  TEST:', runtime.env('TEST'))
  
  console.log('\nOffensive programming:')
  try {
    console.log('  Testing panic...')
    offensive.panic('Browser panic test')
  } catch (e) {
    console.log('  ✓ Panic threw error:', e.message)
    console.log('  Exit code:', e.exitCode)
  }
  
  // Restore Node environment
  global.process = originalProcess
  global.require = originalRequire
  delete global.window
  delete global.document
  
  console.log('\n✨ Browser simulation complete!')
}).catch(err => {
  console.error('Error:', err)
  // Restore on error too
  global.process = originalProcess
  global.require = originalRequire
})