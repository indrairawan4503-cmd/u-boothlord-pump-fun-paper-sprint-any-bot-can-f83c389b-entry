// Adaptive equal-weight pump.fun paper-trading bot (variant C).
//
// Diversified equal-weight entries across many fresh coins, volatility-scaled
// sizing, quick exits (take-profit / stop-loss / time), and a portfolio-level
// drawdown brake. See strategy.ts for the rules. Runs under the grader as
// `node main.ts` (Node 22 type stripping, no build step, no dependencies).

import { runBot } from './vendor/makefun-bot.ts';
import { createAdaptiveBot, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createAdaptiveBot(DEFAULT_PARAMS));
