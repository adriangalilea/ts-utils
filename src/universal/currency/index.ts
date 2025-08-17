export const CurrencySymbols = {
  BTC: '₿',
  XBT: '₿',
  ETH: 'Ξ',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  KRW: '₩',
  INR: '₹',
  RUB: '₽',
  TRY: '₺',
  AUD: 'A$',
  CAD: 'C$',
  CHF: 'Fr',
  HKD: 'HK$',
  SGD: 'S$',
  NZD: 'NZ$',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  PLN: 'zł',
  THB: '฿',
  USDT: '₮',
  USDC: '$',
  DAI: '$',
  BUSD: '$',
} as const

export type CurrencyCode = keyof typeof CurrencySymbols | string

export function getSymbol(code: string): string {
  return CurrencySymbols[code as keyof typeof CurrencySymbols] || code
}

export function getOptimalDecimals(value: number, currencyCode: string): number {
  if (value === 0) {
    return isCrypto(currencyCode) ? 8 : 2
  }
  
  const absValue = Math.abs(value)
  
  switch (currencyCode) {
    case 'BTC':
    case 'XBT':
      if (absValue < 0.00001) return 10
      else if (absValue < 0.0001) return 9
      else if (absValue < 0.001) return 8
      else if (absValue < 0.01) return 7
      else if (absValue < 0.1) return 6
      else if (absValue < 1) return 5
      else return 4
      
    case 'ETH':
      if (absValue < 0.001) return 8
      else if (absValue < 0.01) return 7
      else if (absValue < 0.1) return 6
      else if (absValue < 1) return 5
      else return 4
      
    case 'USD':
    case 'USDT':
    case 'USDC':
    case 'DAI':
    case 'BUSD':
      if (absValue < 0.01) return 6
      else if (absValue < 0.1) return 4
      else if (absValue < 1) return 3
      else return 2
      
    case 'EUR':
    case 'GBP':
    case 'CAD':
    case 'AUD':
    case 'CHF':
      if (absValue < 0.01) return 4
      else if (absValue < 1000) return 2
      else return 0
      
    case 'JPY':
    case 'KRW':
      if (absValue < 1) return 2
      else return 0
  }
  
  if (isCrypto(currencyCode)) {
    if (absValue < 0.00001) return 8
    else if (absValue < 0.0001) return 6
    else if (absValue < 0.001) return 5
    else if (absValue < 0.01) return 4
    else if (absValue < 0.1) return 3
    else if (absValue < 1) return 3
    else if (absValue < 100) return 2
    else return 0
  } else {
    if (absValue < 0.01) return 4
    else if (absValue < 0.1) return 3
    else if (absValue < 1000) return 2
    else return 0
  }
}

import { isCryptoSymbol } from './crypto-symbols.js'

// Alternative ticker mappings (some exchanges use different symbols)
const cryptoAlternatives: Record<string, string> = {
  'XBT': 'BTC',  // BitMEX and some others use XBT for Bitcoin
  'IOTA': 'MIOTA',  // IOTA vs MIOTA
  'STR': 'XLM',  // Stellar old ticker
  'BCHABC': 'BCH',  // Bitcoin Cash ABC
  'BCHSV': 'BSV',  // Bitcoin SV
  'DRK': 'DASH',  // Darkcoin old name
  'XRB': 'NANO',  // RaiBlocks old name
  'ANT': 'ANT',  // Could be Aragon
  'BCC': 'BCH',  // Bittrex used BCC for Bitcoin Cash
  'MIOTA': 'IOTA',  // Some use MIOTA
  'YOYOW': 'YOYOW',  // Various formats
  'IOTX': 'IOTX',  // IoTeX
  'QSH': 'QASH',  // QASH variations
  'YOYO': 'YOYOW',  // YOYOW variations
  'ETHOS': 'BQX',  // Ethos old ticker
  'REP': 'REP',  // Augur variations
  'REPV2': 'REP',  // Augur v2
  'USDt': 'USDT',  // Case variations
  'USDT.e': 'USDT',  // Avalanche USDT
  'USDC.e': 'USDC',  // Avalanche USDC
  'WBTC.e': 'WBTC',  // Avalanche WBTC
  'DAI.e': 'DAI',  // Avalanche DAI
  'BTC.b': 'BTC',  // Avalanche BTC
  'BETH': 'WBETH',  // Binance ETH
  'STETH': 'STETH',  // Lido staked ETH
  'WSTETH': 'WSTETH',  // Wrapped stETH
}

export function isCrypto(code: string): boolean {
  const upperCode = code.toUpperCase()
  
  // Check if it's a known alternative
  if (cryptoAlternatives[upperCode]) {
    return isCryptoSymbol(cryptoAlternatives[upperCode])
  }
  
  // Check if it's a wrapped or bridged token (common patterns)
  const unwrappedCode = upperCode
    .replace(/^W/, '')  // Remove W prefix (WBTC -> BTC)
    .replace(/\.E$/, '')  // Remove .e suffix (USDT.e -> USDT)
    .replace(/\.B$/, '')  // Remove .b suffix (BTC.b -> BTC)
  
  if (unwrappedCode !== upperCode) {
    return isCryptoSymbol(unwrappedCode)
  }
  
  return isCryptoSymbol(upperCode)
}

export function isStablecoin(code: string): boolean {
  const stablecoins = new Set([
    'USDT', 'USDC', 'DAI', 'BUSD', 'UST', 'TUSD', 'USDP', 'GUSD', 'FRAX', 'LUSD'
  ])
  return stablecoins.has(code)
}

export function isFiat(code: string): boolean {
  const fiats = new Set([
    'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'CHF', 'HKD', 'SGD',
    'NZD', 'KRW', 'SEK', 'NOK', 'DKK', 'PLN', 'THB', 'INR', 'RUB', 'TRY',
    'BRL', 'MXN', 'ARS', 'CLP', 'COP', 'PEN', 'UYU', 'ZAR', 'NGN', 'KES'
  ])
  return fiats.has(code)
}

export function percentageOf(value: number, total: number): number {
  if (total === 0) return 0
  return (value / total) * 100
}

export function percentageChange(oldValue: number, newValue: number): number {
  if (oldValue === 0) {
    if (newValue === 0) return 0
    return newValue > 0 ? 100 : -100
  }
  return ((newValue - oldValue) / Math.abs(oldValue)) * 100
}

export function percentageDiff(a: number, b: number): number {
  if (a === 0 && b === 0) return 0
  const avg = (Math.abs(a) + Math.abs(b)) / 2
  if (avg === 0) return 0
  return (Math.abs(a - b) / avg) * 100
}

export function basisPointsToPercent(bps: number): number {
  return bps / 100.0
}

export function percentToBasisPoints(percent: number): number {
  return Math.round(percent * 100)
}

export function formatBasisPoints(bps: number): string {
  return `${bps} bps`
}

export const currency = {
  getSymbol,
  getOptimalDecimals,
  isCrypto,
  isStablecoin,
  isFiat,
  percentageOf,
  percentageChange,
  percentageDiff,
  basisPointsToPercent,
  percentToBasisPoints,
  formatBasisPoints,
  symbols: CurrencySymbols,
}