/** All prices, scores, flows, candles, signals and strategy results are synthetic.
 * No live market feed, ValueScan dataset, backtest, or investment claim is implied.
 */
export const AS_OF = '2026-10-23 19:00';
export const DATA_LABEL = '合成演示数据 · 非实时行情 · 非回测业绩';

// USD prices and aggregate amounts; percentage fields are percentages (2.1 = 2.1%).
const tokenRows = [
  ['BTC', 'Bitcoin', 108432.50, 2.18, 84, 384500000, 28420000000, 2150000000000, '主力增持', 'chance', '#f7931a', 4.82, -1.36, [88, 81, 74, 86, 84]],
  ['ETH', 'Ethereum', 3954.62, 3.52, 87, 264800000, 14860000000, 476000000000, '多周期共振', 'chance', '#7987e8', 7.24, -2.13, [91, 85, 79, 89, 87]],
  ['SOL', 'Solana', 187.24, 4.86, 91, 168600000, 4860000000, 101300000000, '机会增强', 'chance', '#14c9a5', 12.61, -3.25, [94, 90, 86, 88, 92]],
  ['HYPE', 'Hyperliquid', 43.76, -1.82, 62, -18600000, 648000000, 14600000000, '获利减仓', 'risk', '#59ceb1', 8.71, -5.36, [54, 63, 78, 59, 64]],
  ['IRYS', 'Irys', 0.0527, 8.17, 78, 12400000, 189000000, 1054000000, '资金异动', 'motion', '#46c9cf', 19.24, -4.28, [89, 72, 81, 67, 78]],
  ['NEAR', 'NEAR Protocol', 3.481, 5.21, 83, 42800000, 586000000, 4360000000, '趋势资金流入', 'chance', '#6eb6e6', 11.72, -3.18, [88, 86, 72, 80, 82]],
  ['SUI', 'Sui', 3.67, -3.12, 54, -42600000, 918000000, 14900000000, '风险增加', 'risk', '#54aaf1', 10.36, -7.42, [43, 51, 66, 55, 54]],
  ['BNB', 'BNB', 1028.80, 1.56, 81, 68600000, 1290000000, 143000000000, '持续增持', 'motion', '#efb90b', 5.63, -1.47, [85, 82, 70, 88, 80]],
  ['LINK', 'Chainlink', 19.83, 6.14, 88, 64700000, 762000000, 13400000000, '突破观察', 'chance', '#5279ee', 15.48, -3.67, [92, 90, 81, 85, 87]],
  ['DOGE', 'Dogecoin', 0.2187, -2.83, 49, -34700000, 1680000000, 32900000000, '主力减持', 'risk', '#c5a54b', 8.36, -9.13, [38, 46, 75, 41, 48]],
  ['AAVE', 'Aave', 292.46, 2.84, 85, 21300000, 389000000, 4460000000, '短线资金流入', 'motion', '#ae7ad3', 9.36, -2.54, [90, 82, 77, 88, 84]],
  ['WBT', 'WhiteBIT Coin', 48.62, 1.72, 76, 8600000, 128000000, 10500000000, '温和放量', 'motion', '#e5d1a5', 5.18, -1.86, [78, 76, 65, 79, 80]],
];

export const TOKENS = tokenRows.map((row, index) => {
  const [symbol, name, price, change, score, flow, volume, cap, signal, category, color, highGain, drawdown, dimensions] = row;
  return {
    symbol, name, price, change, score, flow, volume, cap, signal, category, color,
    firstTime: `10/23 ${String(10 + index % 7).padStart(2, '0')}:${String(index * 7 % 60).padStart(2, '0')}`,
    initialPrice: Number((price / (1 + (highGain + drawdown) / 100)).toPrecision(8)),
    highGain, drawdown, dimensions,
  };
});

