/**
 * Test file to verify KEV environment variable loading in a monorepo
 * This should demonstrate:
 * 1. Auto-discovery of monorepo root .env
 * 2. Auto-discovery of project root .env  
 * 3. Priority order: local .env > monorepo .env > os env
 * 4. Project/monorepo detection utilities
 */

import { kev, project, log } from '@adriangalilea/utils'

console.log('\n=== Testing KEV in Turborepo Monorepo ===\n')

// Enable debug mode to see the discovery process
kev.debug = true

// Test project/monorepo detection
const projectRoot = project.findProjectRoot()
const monorepoRoot = project.findMonorepoRoot()

log.info('Current working directory:', process.cwd())
log.info('Detected project root:', projectRoot || 'NOT FOUND')
log.info('Detected monorepo root:', monorepoRoot || 'NOT FOUND')

console.log('\n--- KEV Source Chain ---')
log.info('KEV sources:', kev.source.list())

console.log('\n--- Testing Environment Variables ---\n')

// Test variables from different sources
const tests = [
  // From API's .env (should override)
  { key: 'API_PORT', expected: '3001', description: 'API-specific variable' },
  { key: 'API_KEY', expected: 'api_key_456', description: 'API-specific variable' },
  { key: 'API_VERSION', expected: 'v1', description: 'API-specific variable' },
  
  // From monorepo root .env
  { key: 'MONOREPO_NAME', expected: 'test-monorepo', description: 'Monorepo-level variable' },
  { key: 'MONOREPO_ENV', expected: 'development', description: 'Monorepo-level variable' },
  { key: 'API_BASE_URL', expected: 'http://localhost:3000', description: 'Monorepo-level variable' },
  
  // Overridden variables (local should win)
  { key: 'DATABASE_URL', expected: 'postgres://localhost/api_specific_db', description: 'Should be overridden by API .env' },
  { key: 'SHARED_SECRET', expected: 'api_override_secret', description: 'Should be overridden by API .env' },
  
  // From OS environment
  { key: 'PATH', expected: 'exists', description: 'OS environment variable' },
  { key: 'HOME', expected: 'exists', description: 'OS environment variable' },
]

tests.forEach(test => {
  const value = kev.get(test.key)
  const source = kev.sourceOf(test.key)
  
  if (test.expected === 'exists') {
    if (value) {
      log.success(`✓ ${test.key}: Found (${test.description})`)
      log.info(`  Value: ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`)
      log.info(`  Source: ${source}`)
    } else {
      log.error(`✗ ${test.key}: Not found (${test.description})`)
    }
  } else {
    if (value === test.expected) {
      log.success(`✓ ${test.key}: ${value} (${test.description})`)
      log.info(`  Source: ${source}`)
    } else {
      log.error(`✗ ${test.key}: Expected "${test.expected}", got "${value}"`)
      log.info(`  Source: ${source}`)
    }
  }
})

console.log('\n--- Testing Namespaced Access ---\n')

// Test direct namespace access
log.info('Direct from OS:')
console.log('  os:PATH =', kev.get('os:PATH')?.substring(0, 50) + '...')

log.info('Direct from API .env:')
console.log('  .env:API_KEY =', kev.get('.env:API_KEY'))

log.info('Direct from monorepo .env:')
const monorepoEnvPath = monorepoRoot ? `${monorepoRoot}/.env` : '../../../.env'
console.log(`  ${monorepoEnvPath}:MONOREPO_NAME =`, kev.get(`${monorepoEnvPath}:MONOREPO_NAME`))

console.log('\n--- Testing Pattern Matching ---\n')

// Find all API_ variables
const apiVars = kev.keys('API_*')
log.info(`Found ${apiVars.length} API_* variables:`, apiVars)

// Find all variables from monorepo
const monorepoVars = kev.keys('MONOREPO_*')
log.info(`Found ${monorepoVars.length} MONOREPO_* variables:`, monorepoVars)

console.log('\n--- Testing Type Conversions ---\n')

// Test type conversions
const port = kev.int('API_PORT', 3000)
log.info(`API_PORT as int: ${port} (type: ${typeof port})`)

// Test with a boolean-like variable
kev.set('DEBUG', 'true')
const debugMode = kev.bool('DEBUG', false)
log.info(`DEBUG as bool: ${debugMode}`)

console.log('\n--- Testing All Variables ---\n')

// Show all variables by namespace
const all = kev.all('*:*')
Object.entries(all).forEach(([namespace, vars]) => {
  const count = Object.keys(vars).length
  log.info(`${namespace}: ${count} variables`)
})

console.log('\n=== Test Complete ===\n')

// Disable debug mode
kev.debug = false