import { 
  log,
  currency,
  format
} from '../src/index.js'

console.log('\n=== Logger Examples ===\n')

// Basic logging
log.wait('Loading resources...')
log.info('This is an info message')
log.success('Operation completed successfully')
log.warn('This is a warning')
log.error('This is an error')
log.event('User logged in')
log.trace('Trace: function called')
log.ready('Server is ready')

// Warn once
log.warnOnce('This warning appears only once')
log.warnOnce('This warning appears only once') // Won't show again

// Timer
log.time('dataFetch')
setTimeout(() => {
  log.timeEnd('dataFetch')
}, 100)

// Prefixed logger
const apiLogger = log.createLogger('API')
apiLogger.info('Request received')
apiLogger.success('Response sent')
apiLogger.error('Connection failed')

console.log('\n=== Currency Examples ===\n')

// Currency type checking
console.log('isCrypto("BTC"):', currency.isCrypto('BTC'))
console.log('isCrypto("XBT"):', currency.isCrypto('XBT')) // Alternative for BTC
console.log('isCrypto("WBTC"):', currency.isCrypto('WBTC')) // Wrapped BTC
console.log('isCrypto("USD"):', currency.isCrypto('USD'))
console.log('isStablecoin("USDT"):', currency.isStablecoin('USDT'))
console.log('isStablecoin("BTC"):', currency.isStablecoin('BTC'))
console.log('isFiat("USD"):', currency.isFiat('USD'))
console.log('isFiat("EUR"):', currency.isFiat('EUR'))
console.log('isFiat("BTC"):', currency.isFiat('BTC'))

// Currency symbols
console.log('\nCurrency Symbols:')
console.log('BTC:', currency.getSymbol('BTC'))
console.log('ETH:', currency.getSymbol('ETH'))
console.log('USD:', currency.getSymbol('USD'))
console.log('EUR:', currency.getSymbol('EUR'))
console.log('JPY:', currency.getSymbol('JPY'))

// Optimal decimals
console.log('\nOptimal Decimals:')
console.log('0.00001234 BTC:', currency.getOptimalDecimals(0.00001234, 'BTC'), 'decimals')
console.log('1234.56 USD:', currency.getOptimalDecimals(1234.56, 'USD'), 'decimals')
console.log('0.123 ETH:', currency.getOptimalDecimals(0.123, 'ETH'), 'decimals')
console.log('999999 JPY:', currency.getOptimalDecimals(999999, 'JPY'), 'decimals')

// Format examples
console.log('\nFormat Examples:')
console.log('USD:', format.usd(1234.56))
console.log('BTC:', format.btc(0.00001234))
console.log('ETH:', format.eth(0.123))
console.log('Auto USD:', format.auto(1234.56, 'USD'))
console.log('Percentage:', format.percentage(12.5))
console.log('With commas:', format.withCommas(1234567.89, 2))
console.log('Compact:', format.compact(1234567))

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