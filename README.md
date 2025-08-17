# ts-utils

TypeScript utilities - logger, currency, offensive programming, file operations, environment management, and more.

## Installation

```bash
# Using JSR (recommended)
pnpm dlx jsr add @adriangalilea/utils

# or with npm
npx jsr add @adriangalilea/utils
```

## Usage

### Logger

Next.js-style logger with colored output and Unicode symbols:

```typescript
import { wait, error, warn, ready, info, success, event, trace, createLogger } from '@adriangalilea/utils'

// Basic logging
wait('Loading...')
error('Something went wrong')
warn('This is a warning')
ready('Server is ready')
info('Information message')
success('Operation successful')
event('Event occurred')
trace('Trace message')

// Warn once (won't repeat same message)
warnOnce('This warning appears only once')

// Timer functionality
time('operation')
// ... do something
timeEnd('operation') // outputs: operation: 123ms

// Create prefixed logger
const apiLogger = createLogger('API')
apiLogger.info('Request received')  // [API] Request received
```

### Currency

Currency utilities with comprehensive crypto support (500+ symbols):

```typescript
import { currency, isCrypto, isStablecoin, isFiat, getSymbol, getOptimalDecimals } from '@adriangalilea/utils'

// Check currency types
isCrypto('BTC')  // true
isCrypto('XBT')  // true (alternative for BTC)
isCrypto('WBTC')  // true (wrapped tokens detected)
isStablecoin('USDT')  // true
isFiat('USD')  // true

// Get currency symbols
getSymbol('BTC')  // '₿'
getSymbol('ETH')  // 'Ξ'
getSymbol('USD')  // '$'

// Get optimal decimal places based on value
getOptimalDecimals(0.00001234, 'BTC')  // 10
getOptimalDecimals(1234.56, 'USD')  // 2
getOptimalDecimals(0.123, 'ETH')  // 6

// Percentage calculations
currency.percentageOf(25, 100)  // 25
currency.percentageChange(100, 150)  // 50
currency.percentageDiff(100, 150)  // 40

// Basis points
currency.basisPointsToPercent(100)  // 1
currency.percentToBasisPoints(1)  // 100
currency.formatBasisPoints(50)  // "50 bps"
```

## Features

- **Logger**: Next.js-style colored console output with symbols
- **Currency**: 
  - 13,750+ crypto symbols from CoinGecko (auto-updatable)
  - Alternative ticker support (XBT→BTC, wrapped tokens, etc.)
  - Optimal decimal calculations
  - Percentage and basis point utilities
  - Fiat and stablecoin detection
- **Offensive Programming**: Assert, must, check, panic utilities
- **File Operations**: Read, write with automatic path resolution
- **Directory Operations**: Create, list, walk directories
- **KEV**: Redis-style environment variable management with monorepo support
- **Project Discovery**: Find project/monorepo roots, detect JS/TS projects

## License

MIT