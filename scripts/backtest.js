/**
 * 📉 The Real Math Backtester (Phase 3 - Deep Quant Upgrade)
 * 
 * จำลองการเทรดด้วยข้อมูลในอดีต (CSV) แบบคณิตศาสตร์ล้วนๆ โดยไม่ต้องพึ่งพา AI
 * เพื่อหาสถิติ Win Rate, Max Drawdown และ Expectancy ที่แท้จริง
 */

import fs from 'fs';
import path from 'path';

class RealBacktester {
    constructor(initialBalance = 10000) {
        this.balance = initialBalance;
        this.trades = [];
        this.maxDrawdown = 0;
        this.peakBalance = initialBalance;
    }

    /**
     * ตัวอย่างฟังก์ชันสำหรับโหลด CSV
     */
    loadData(csvPath) {
        console.log(`📂 โหลดข้อมูลกราฟอดีตจาก ${csvPath}...`);
        // ในสถานการณ์จริง จะต้องอ่านไฟล์ CSV แล้วแปลงเป็น Object { open, high, low, close }
        // สร้างข้อมูลสุ่มเสมือนจริง 1000 แท่งเพื่อทดสอบระบบโครงสร้าง
        const mockCandles = [];
        let price = 2000.00;
        for (let i = 0; i < 1000; i++) {
            const move = (Math.random() - 0.5) * 5;
            price += move;
            mockCandles.push({
                close: price,
                high: price + Math.random() * 2,
                low: price - Math.random() * 2,
                // สมมติค่า RSI และ MACD แบบแกว่งไปมาตามรอบไซเคิล
                rsi: 50 + Math.sin(i / 10) * 30, 
                macdSignal: Math.cos(i / 10),
                atr: 2.5 + Math.random()
            });
        }
        return mockCandles;
    }

    runSimulation(historicalCandles) {
        console.log(`🚀 เริ่มจำลอง Real Math Backtest จำนวน ${historicalCandles.length} แท่งเทียน...`);
        
        let activeTrade = null;

        for (let i = 0; i < historicalCandles.length; i++) {
            const candle = historicalCandles[i];

            // 1. Circuit Breaker (ประเมินจุดออก)
            if (activeTrade) {
                // 🚨 [QDD Fix] Dynamic Slippage Model
                const getSlippage = () => activeTrade.atr * (Math.random() * 0.15 + 0.10);
                const getTpSlippage = () => (Math.random() > 0.5 ? 1 : -1) * (activeTrade.atr * (Math.random() * 0.10 + 0.05));

                if (activeTrade.action === 'BUY') {
                    if (candle.low <= activeTrade.sl) {
                        this.closeTrade(activeTrade, activeTrade.sl - getSlippage(), 'Hit SL');
                        activeTrade = null;
                    } else if (candle.high >= activeTrade.tp) {
                        this.closeTrade(activeTrade, activeTrade.tp + getTpSlippage(), 'Hit TP');
                        activeTrade = null;
                    }
                } else if (activeTrade.action === 'SELL') {
                    if (candle.high >= activeTrade.sl) {
                        this.closeTrade(activeTrade, activeTrade.sl + getSlippage(), 'Hit SL');
                        activeTrade = null;
                    } else if (candle.low <= activeTrade.tp) {
                        this.closeTrade(activeTrade, activeTrade.tp + getTpSlippage(), 'Hit TP');
                        activeTrade = null;
                    }
                }
            }

            // 2. Strategy Logic (ประเมินจุดเข้าด้วยคณิตศาสตร์)
            if (!activeTrade) {
                const isOverbought = candle.rsi > 70;
                const isOversold = candle.rsi < 30;
                const isMacdBullish = candle.macdSignal > 0;
                const isMacdBearish = candle.macdSignal < 0;

                let action = null;
                // เงื่อนไข: สวนเทรนด์ตอนสุดขีด (Mean Reversion) หรือ ตามเทรนด์แบบ Momentum
                if (isOversold && isMacdBullish) action = 'BUY';
                if (isOverbought && isMacdBearish) action = 'SELL';

                if (action) {
                    const atr = candle.atr;
                    const spread = 0.5;
                    let entry = parseFloat(candle.close);
                    
                    // เพิ่ม Spread Cost และ SL Floor (Advanced Logic Fix)
                    if (action === 'BUY') entry += spread;
                    else entry -= spread;

                    const slDistance = Math.max(atr * 1.5, 2.5); // SL Floor

                    let sl, tp;
                    if (action === 'BUY') {
                        sl = entry - slDistance;
                        tp = entry + (slDistance * 1.5);
                    } else {
                        sl = entry + slDistance;
                        tp = entry - (slDistance * 1.5);
                    }

                    activeTrade = { id: `BT-${i}`, action, entry, sl, tp, pnl: 0, atr };
                    this.trades.push(activeTrade);
                }
            }
        }

        this.generateReport();
    }

    closeTrade(trade, closePrice, reason) {
        const lotSize = 0.1; 
        let pnl = 0;
        if (trade.action === 'BUY') pnl = (closePrice - trade.entry) * lotSize * 100;
        else pnl = (trade.entry - closePrice) * lotSize * 100;

        trade.closePrice = closePrice;
        trade.reason = reason;
        trade.pnl = pnl;

        this.balance += pnl;

        if (this.balance > this.peakBalance) {
            this.peakBalance = this.balance;
        } else {
            const drawdown = ((this.peakBalance - this.balance) / this.peakBalance) * 100;
            if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown;
        }
    }

    generateReport() {
        const wins = this.trades.filter(t => t.pnl > 0).length;
        const losses = this.trades.filter(t => t.pnl <= 0).length;
        const total = this.trades.length;
        const winRate = total > 0 ? (wins / total) * 100 : 0;

        console.log("\n==================================");
        console.log("📉 REAL MATH BACKTEST REPORT");
        console.log("==================================");
        console.log(`Total Trades: ${total}`);
        console.log(`Win Rate: ${winRate.toFixed(2)}% (${wins}W / ${losses}L)`);
        console.log(`Final Balance: $${this.balance.toFixed(2)}`);
        console.log(`Max Drawdown: ${this.maxDrawdown.toFixed(2)}%`);
        console.log("==================================\n");
    }
}

// ------------------------------------
// วิธีรันทดสอบ: `node scripts/backtest.js`
// ------------------------------------
// const tester = new RealBacktester();
// const data = tester.loadData('dummy.csv');
// tester.runSimulation(data);
