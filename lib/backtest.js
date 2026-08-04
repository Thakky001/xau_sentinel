import fs from 'fs';
import path from 'path';
import { fetchDerivMultiCandles, processCandles } from './deriv.js';

const CACHE_FILE = path.join(process.cwd(), 'backtest_cache.json');

// 1. Historical Data Loader
export async function loadHistoricalData(days = 30) {
    console.log(`[Backtest] Loading historical data for the last ${days} days...`);
    const m15Count = (days * 24 * 4) + 200; // + buffer for indicators
    const h1Count = (days * 24) + 200;

    // Check cache
    if (fs.existsSync(CACHE_FILE)) {
        const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        if (cache.days === days) {
            console.log(`[Backtest] Using cached data (saved at ${new Date(cache.timestamp).toLocaleString()})`);
            return cache.data;
        }
    }

    console.log(`[Backtest] Fetching from Deriv API (M15: ${m15Count}, H1: ${h1Count})...`);
    
    return new Promise(async (resolve, reject) => {
        const wsModule = await import('ws');
        const WebSocket = wsModule.default;
        const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
        
        const fetchChunks = async (granularity, totalRequired, reqIdBase) => {
            let collected = [];
            let currentEnd = 'latest';
            let reqId = reqIdBase;
            
            while (collected.length < totalRequired) {
                const remaining = totalRequired - collected.length;
                const fetchCount = Math.min(remaining, 5000);
                
                const promise = new Promise((res, rej) => {
                    const listener = (data) => {
                        const parsed = JSON.parse(data.toString());
                        if (parsed.error) return rej(parsed.error.message);
                        if (parsed.msg_type === 'candles' && parsed.req_id === reqId) {
                            ws.removeListener('message', listener);
                            res(parsed.candles);
                        }
                    };
                    ws.on('message', listener);
                    ws.send(JSON.stringify({
                        ticks_history: 'frxXAUUSD', style: 'candles', granularity, count: fetchCount, end: currentEnd, req_id: reqId
                    }));
                });
                
                const chunk = await promise;
                if (!chunk || chunk.length === 0) break;
                
                collected = chunk.concat(collected);
                currentEnd = chunk[0].epoch; // Next chunk ends at the start of current chunk
                reqId++;
            }
            return collected;
        };

        ws.on('open', async () => {
            try {
                process.stdout.write('[Backtest] Downloading M15 chunks... ');
                const m15Data = await fetchChunks(900, m15Count, 100);
                console.log(`Done (${m15Data.length} candles)`);
                
                process.stdout.write('[Backtest] Downloading H1 chunks... ');
                const h1Data = await fetchChunks(3600, h1Count, 200);
                console.log(`Done (${h1Data.length} candles)`);
                
                ws.close();
                
                const results = { m15: m15Data, h1: h1Data };
                const cacheData = { days, timestamp: Date.now(), data: results };
                fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData));
                resolve(results);
            } catch (err) {
                reject(err);
                ws.close();
            }
        });
        
        ws.on('error', reject);
    });
}

// 2. Mock AI Decision Engine
function mockAIDecision(h1Data, m15Data, activeClusters, triggerReasons, params) {
    const h1Trend = h1Data.ema_fast > h1Data.ema_slow ? "ขาขึ้น" : "ขาลง";
    const trendAligned = 
        (h1Trend === 'ขาขึ้น' && m15Data.market_structure.includes('ขาขึ้น')) ||
        (h1Trend === 'ขาลง' && m15Data.market_structure.includes('ขาลง'));

    // Rule 5: Dynamic ADX Threshold
    if (h1Data.adx < params.adxThreshold) return { action: 'WAIT', confidence: 'LOW', reason: `ADX < ${params.adxThreshold}` };

    // Rule 6: Alignment check
    if (!trendAligned) {
        // Counter-trend check (Rule 3)
        const isReversal = triggerReasons.some(r => r.includes('Engulfing') || r.includes('Pin Bar'));
        const bodySufficient = m15Data.candle_body_size > (m15Data.atr * 0.5);
        const nearFibo = activeClusters.has('ValueZone');

        if (isReversal && bodySufficient && nearFibo) {
            const action = m15Data.candlestick_pattern.includes('Bullish') ? 'BUY' : 'SELL';
            // Need to check if it's truly counter trend matching the pattern. 
            // e.g. H1 is downtrend, we want to BUY counter trend. Bullish pattern is required.
            if ((h1Trend === 'ขาลง' && action === 'BUY') || (h1Trend === 'ขาขึ้น' && action === 'SELL')) {
                return { action, confidence: 'MEDIUM', reason: 'Counter-trend with strong structure' };
            }
        }
        return { action: 'WAIT', confidence: 'LOW', reason: 'Counter-trend without strong reversal' };
    }

    // Trend is aligned
    // Rule 2: Follow trend
    if (activeClusters.has('Momentum') && h1Data.adx > 25) {
        const action = h1Trend === 'ขาขึ้น' ? 'BUY' : 'SELL';
        return { action, confidence: 'HIGH', reason: 'Trend aligned with strong momentum' };
    }

    // Default trend follow
    if (activeClusters.size >= params.minClusters) {
        const action = h1Trend === 'ขาขึ้น' ? 'BUY' : 'SELL';
        return { action, confidence: 'MEDIUM', reason: 'Trend aligned but moderate ADX/momentum' };
    }

    return { action: 'WAIT', confidence: 'LOW', reason: 'Default WAIT' };
}

// 3. Trade Simulator & Walk-Forward Simulation
export async function runBacktest(days = 30, params = {}) {
    const config = {
        adxThreshold: params.adxThreshold || 20,
        minClusters: params.minClusters || 2,
        rrRatio: params.rrRatio || 1.5,
        silent: params.silent || false
    };
    const data = await loadHistoricalData(days);
    
    // We need at least 100 candles for indicator warmup
    const startIdxM15 = 100;
    const startIdxH1 = Math.floor(100 / 4); // H1 index approx
    
    let activeTrade = null;
    let balance = 1000;
    const trades = [];
    
    if (!config.silent) console.log(`[Backtest] Starting Walk-Forward Simulation from ${new Date(data.m15[startIdxM15].epoch * 1000).toLocaleString()}...`);

    for (let i = startIdxM15; i < data.m15.length; i++) {
        // Optimize: Only feed last 200 candles to processCandles (saves O(N^2) CPU time)
        const m15Slice = data.m15.slice(Math.max(0, i - 200), i + 1);
        
        // Find corresponding H1 slice
        const currentEpoch = data.m15[i].epoch;
        const h1Idx = data.h1.findIndex(c => c.epoch > currentEpoch);
        const h1Slice = data.h1.slice(Math.max(0, (h1Idx === -1 ? data.h1.length : h1Idx) - 200), h1Idx === -1 ? data.h1.length : h1Idx);

        if (h1Slice.length < 50 || m15Slice.length < 100) continue;

        // Process indicators
        const h1Data = processCandles(h1Slice, 'light');
        const m15Data = processCandles(m15Slice, 'full');

        const currentPrice = parseFloat(data.m15[i].close);

        // Check active trade
        if (activeTrade) {
            const high = parseFloat(data.m15[i].high);
            const low = parseFloat(data.m15[i].low);
            let closed = false;

            if (activeTrade.type === 'BUY') {
                if (low <= activeTrade.sl) { activeTrade.pnl = (activeTrade.sl - activeTrade.entry) * 0.01 * 100; closed = true; activeTrade.exitReason = 'SL'; }
                else if (high >= activeTrade.tp) { activeTrade.pnl = (activeTrade.tp - activeTrade.entry) * 0.01 * 100; closed = true; activeTrade.exitReason = 'TP'; }
            } else {
                if (high >= activeTrade.sl) { activeTrade.pnl = (activeTrade.entry - activeTrade.sl) * 0.01 * 100; closed = true; activeTrade.exitReason = 'SL'; }
                else if (low <= activeTrade.tp) { activeTrade.pnl = (activeTrade.entry - activeTrade.tp) * 0.01 * 100; closed = true; activeTrade.exitReason = 'TP'; }
            }

            if (closed) {
                // Apply 0.2 spread penalty per trade
                activeTrade.pnl -= 0.2; 
                balance += activeTrade.pnl;
                trades.push({...activeTrade});
                activeTrade = null;
            }
            continue; // Skip new signals if trade is active
        }

        // Generate triggers (Same logic as bot.js)
        const activeClusters = new Set();
        const triggerReasons = [];

        // Momentum
        let momentumScore = 0;
        if (m15Data.rsi > 65) momentumScore -= 1;
        if (m15Data.rsi < 35) momentumScore += 1;
        if (m15Data.macd) {
            if (m15Data.macd.state.includes('Golden Cross') || m15Data.macd.state.includes('ขาขึ้นแข็งแกร่ง')) momentumScore += 1;
            if (m15Data.macd.state.includes('Death Cross') || m15Data.macd.state.includes('ขาลงแข็งแกร่ง')) momentumScore -= 1;
        }
        if (Math.abs(momentumScore) >= 1) activeClusters.add('Momentum');

        // Value Zone
        if (m15Data.fibo && m15Data.atr) {
            const tolerance = m15Data.atr * 0.8;
            const isNear = (p, level) => Math.abs(p - level) <= tolerance;
            if (isNear(currentPrice, m15Data.fibo.level_50_0) || isNear(currentPrice, m15Data.fibo.level_61_8)) activeClusters.add('ValueZone');
        }
        if (m15Data.round_number && !m15Data.round_number.includes('ไม่มี')) activeClusters.add('ValueZone');

        // Structure
        if (!m15Data.candlestick_pattern.includes('ไม่มีรูปแบบ')) {
            activeClusters.add('Structure');
            triggerReasons.push(m15Data.candlestick_pattern);
        }
        if (!m15Data.breakout.includes('Sideway')) activeClusters.add('Structure');

        if (activeClusters.size < config.minClusters) continue;

        // Call Mock AI
        const decision = mockAIDecision(h1Data, m15Data, activeClusters, triggerReasons, config);

        if (decision.confidence === 'LOW' || decision.action === 'WAIT') continue;

        // Structure Guard / R:R Check
        const atr = m15Data.atr;
        let sl, tp;
        if (decision.action === 'BUY') {
            sl = m15Data.recent_low - (atr * 0.5);
            const risk = currentPrice - sl;
            tp = currentPrice + (risk * config.rrRatio); // Dynamic RR target
            // basic structure guard: if TP > recent high significantly, it might be blocked, but let's simplify for backtest
            if (risk > atr * 3) continue; // too much risk
        } else {
            sl = m15Data.recent_high + (atr * 0.5);
            const risk = sl - currentPrice;
            tp = currentPrice - (risk * config.rrRatio);
            if (risk > atr * 3) continue;
        }

        // Open Trade
        activeTrade = {
            type: decision.action,
            entry: currentPrice,
            sl: sl,
            tp: tp,
            time: new Date(currentEpoch * 1000),
            reason: decision.reason
        };
    }

    // 4. Performance Reporter
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.length - wins;
    const winRate = trades.length > 0 ? ((wins / trades.length) * 100).toFixed(1) : 0;
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? 999 : 0);
    const netPnl = grossProfit - grossLoss;

    if (!config.silent) {
        console.log('\n📊 Backtest Results (' + days + ' days, M15)');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`Total Trades:     ${trades.length}`);
        console.log(`Win Rate:         ${winRate}% (${wins}W / ${losses}L)`);
        console.log(`Profit Factor:    ${profitFactor.toFixed(2)}`);
        console.log(`Total PnL:        ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`);
        console.log(`Avg Win:          $${wins > 0 ? (grossProfit / wins).toFixed(2) : '0.00'}`);
        console.log(`Avg Loss:         -$${losses > 0 ? (grossLoss / losses).toFixed(2) : '0.00'}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    }
    
    return {
        trades: trades.length,
        winRate: parseFloat(winRate),
        profitFactor: profitFactor,
        netPnl: netPnl,
        wins,
        losses
    };
}
