import { 
  wait, error, warn, ready, info, success, event, trace, 
  createLogger, warnOnce, time, timeEnd,
  currency, isCrypto, isStablecoin, isFiat, getSymbol, getOptimalDecimals 
} from '../src/index.js'

console.log('\n=== Logger Examples ===\n')

// Basic logging
wait('Loading resources...')
info('This is an info message')
success('Operation completed successfully')
warn('This is a warning')
error('This is an error')
event('User logged in')
trace('Trace: function called')
ready('Server is ready')

// Warn once
warnOnce('This warning appears only once')
warnOnce('This warning appears only once') // Won't show again

// Timer
time('dataFetch')
setTimeout(() => {
  timeEnd('dataFetch')
}, 100)

// Prefixed logger
const apiLogger = createLogger('API')
apiLogger.info('Request received')
apiLogger.success('Response sent')
apiLogger.error('Connection failed')

console.log('\n=== Currency Examples ===\n')

// Currency type checking
console.log('isCrypto("BTC"):', isCrypto('BTC'))
console.log('isCrypto("XBT"):', isCrypto('XBT')) // Alternative for BTC
console.log('isCrypto("WBTC"):', isCrypto('WBTC')) // Wrapped BTC
console.log('isCrypto("USD"):', isCrypto('USD'))
console.log('isStablecoin("USDT"):', isStablecoin('USDT'))
console.log('isStablecoin("BTC"):', isStablecoin('BTC'))
console.log('isFiat("USD"):', isFiat('USD'))
console.log('isFiat("EUR"):', isFiat('EUR'))
console.log('isFiat("BTC"):', isFiat('BTC'))

// Currency symbols
console.log('\nCurrency Symbols:')
console.log('BTC:', getSymbol('BTC'))
console.log('ETH:', getSymbol('ETH'))
console.log('USD:', getSymbol('USD'))
console.log('EUR:', getSymbol('EUR'))
console.log('JPY:', getSymbol('JPY'))

// Optimal decimals
console.log('\nOptimal Decimals:')
console.log('0.00001234 BTC:', getOptimalDecimals(0.00001234, 'BTC'), 'decimals')
console.log('1234.56 USD:', getOptimalDecimals(1234.56, 'USD'), 'decimals')
console.log('0.123 ETH:', getOptimalDecimals(0.123, 'ETH'), 'decimals')
console.log('999999 JPY:', getOptimalDecimals(999999, 'JPY'), 'decimals')

// Percentage calculations
console.log('\nPercentage Calculations:')
console.log('25 is', currency.percentageOf(25, 100) + '% of 100')
console.log('Change from 100 to 150:', currency.percentageChange(100, 150) + '%')
console.log('Difference between 100 and 150:', currency.percentageDiff(100, 150) + '%')

// Basis points
console.log('\nBasis Points:')
console.log('100 bps =', currency.basisPointsToPercent(100) + '%')
console.log('2.5% =', currency.percentToBasisPoints(2.5), 'bps')
console.log('Formatted:', currency.formatBasisPoints(50))

// Wait for timer to complete
setTimeout(() => {
  console.log('\n✨ Example completed!')
}, 150)