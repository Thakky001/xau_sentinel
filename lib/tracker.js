import WebSocket from 'ws';
import { updateOrderInSheet } from './sheets.js';
import { sendTelegramMessage } from './telegram.js';
import { isWeekendApproaching } from './bot.js';
import { isHighImpactNewsApproaching } from './news.js';

/**
 * Tracker Bot (Circuit Breaker)
 * หน้าที่: เกาะติดราคา Tick แบบ Real-time และทำหน้าที่เป็น Circuit Breaker 
 * คอยเช็คว่าราคาปัจจุบันชน SL, TP หรือจุดตั้ง BE ของออเดอร์ที่เปิดอยู่หรือไม่
 */

let trackerSocket = null;
let trackerInterval = null; // เก็บอ้างอิง interval เพื่อเคลียร์เวลา reconnect
export let activeOrders = []; // เก็บออเดอร์ที่ได้มาจาก Scout Bot หรือ Google Sheets
export let portfolioBalance = 100.00; // Mock Initial Balance

export function getPortfolioState() {
    return {
        balance: portfolioBalance,
        activeOrders: activeOrders
    };
}
export function startTracker(initialOrders = null, initialBalance = null) {
    if (trackerInterval) {
        clearInterval(trackerInterval); // ป้องกันบั๊ก interval ซ้อนทับเวลารีคอนเนค
    }
    
    // 1. นำข้อมูลออเดอร์ค้างจากรอบที่แล้วกลับเข้า Memory (ถ้ามีการส่งค่ามาตอนบูตระบบ)
    if (initialBalance !== null) portfolioBalance = initialBalance;
    if (initialOrders !== null) {
        initialOrders.forEach(order => {
            if (!activeOrders.find(o => o.id === order.id)) {
                activeOrders.push(order);
            }
        });
    }

    console.log(`🛡️ Tracker Bot กำลังเชื่อมต่อ WebSocket... (เฝ้าระวัง ${activeOrders.length} ไม้) | Balance: $${portfolioBalance.toFixed(2)}`);
    trackerSocket = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

    trackerSocket.on('open', () => {
        console.log('✅ Tracker Bot เชื่อมต่อสำเร็จ! กำลังเฝ้าดู XAUUSD (Polling 5s)');
        
        // วนลูปขอราคาทุก 5 วินาที เพื่อหลีกเลี่ยง Rate Limit ของ Deriv API
        // หากไม่มีไม้ค้าง ให้ส่ง ping เพื่อรักษาการเชื่อมต่อไม่ให้ถูกตัด (Idle Timeout)
        trackerInterval = setInterval(() => {
            if (trackerSocket.readyState === WebSocket.OPEN) {
                if (activeOrders.length > 0) {
                    trackerSocket.send(JSON.stringify({
                        ticks_history: 'frxXAUUSD',
                        end: 'latest',
                        count: 1,
                        style: 'candles',
                        granularity: 60
                    }));
                } else {
                    trackerSocket.send(JSON.stringify({ ping: 1 }));
                }
            }
        }, 5000);
    });

    trackerSocket.on('message', (data) => {
        try {
            const response = JSON.parse(data.toString());
            if (response.error && response.error.code !== 'InvalidSymbol') {
                console.error("⚠️ Tracker WS Error:", response.error.message);
            }
            if (response.msg_type === 'candles' && response.candles && response.candles.length > 0) {
                const candle = response.candles[response.candles.length - 1];
                const currentPrice = candle.close;
                checkCircuitBreaker(currentPrice);
            }
        } catch (e) {
            console.error("Tracker parse error:", e);
        }
    });

    trackerSocket.on('error', (err) => {
        console.error("Tracker WS error:", err);
    });

    trackerSocket.on('close', () => {
        if (trackerInterval) clearInterval(trackerInterval);
        console.log('⚠️ Tracker Bot หลุดการเชื่อมต่อ จะพยายามเชื่อมใหม่ใน 15 วินาที...');
        setTimeout(() => startTracker(null, portfolioBalance), 15000);
    });
}

async function checkCircuitBreaker(currentPrice) {
    if (activeOrders.length === 0) return;

    // 🚨 [QDD Fix] ตรวจสอบ Weekend & News Liquidator
    const forceCloseReason = isWeekendApproaching() ? 'Weekend Liquidator' : 
                             isHighImpactNewsApproaching() ? 'News Liquidator' : null;

    for (let i = activeOrders.length - 1; i >= 0; i--) {
        const order = activeOrders[i];
        let isClosed = false;
        let status = '';
        let reason = '';
        let pnl = 0;
        let finalClosePrice = currentPrice;
        const lotSize = 0.01;

        // 🚨 [QDD Fix] Dynamic Slippage Model อิงตาม ATR
        // เราคำนวณ ATR กลับมาจากระยะ SL (เพราะ SL = 1.5 * ATR)
        const currentAtr = Math.abs(order.entry - order.sl) / 1.5;
        
        // Slippage จะผันผวน 10% - 25% ของ ATR
        const getSlippage = () => {
            const slipMultiplier = Math.random() * 0.15 + 0.10;
            return currentAtr * slipMultiplier;
        }; 
        const getTpSlippage = () => {
            const slipMultiplier = Math.random() * 0.10 + 0.05;
            return (Math.random() > 0.5 ? 1 : -1) * (currentAtr * slipMultiplier);
        };

        if (forceCloseReason) {
            isClosed = true;
            reason = forceCloseReason;
            // สุ่ม Slippage มหาโหด (20% - 40% ของ ATR) สำหรับการหนีตายตอนข่าวหรือปิดศุกร์
            const panicSlippage = currentAtr * (Math.random() * 0.20 + 0.20);
            
            if (order.action === 'BUY') {
                finalClosePrice = currentPrice - panicSlippage;
                pnl = (finalClosePrice - order.entry) * lotSize * 100;
            } else {
                finalClosePrice = currentPrice + panicSlippage;
                pnl = (order.entry - finalClosePrice) * lotSize * 100;
            }
            status = pnl >= 0 ? 'WIN' : 'LOSS';
        } else if (order.action === 'BUY') {
            // 1. เช็คเลื่อนบังทุน (BE)
            if (order.be && currentPrice >= order.be && order.sl < order.entry) {
                order.sl = order.entry + 0.5; // ขยับ SL เหนือทุนนิดนึง (กัน Spread)
                console.log(`🛡️ [Break Even] ไม้ ${order.id} ขยับ SL บังทุนที่ ${order.sl.toFixed(2)}`);
                updateOrderInSheet(order.id, { Status: 'BREAKEVEN', SL_Price: order.sl }).catch(() => {});
                sendTelegramMessage(`🛡️ <b>ขยับ SL บังทุน (BE)</b>\n🆔 ${order.id}\n📍 SL ใหม่: ${order.sl.toFixed(2)}`).catch(() => {});
            }

            // 2. เช็ค SL / TP
            if (currentPrice <= order.sl) {
                isClosed = true; status = 'LOSS'; reason = 'Hit SL';
                const isBE = (order.sl === order.entry + 0.5);
                const slip = isBE ? 0 : getSlippage(); // ชนหน้าทุนมักไม่ค่อย Slip หนัก
                finalClosePrice = currentPrice - slip;
                pnl = (finalClosePrice - order.entry) * lotSize * 100;
                if (isBE) { status = 'WIN'; reason = 'Hit BE (Safe)'; } // ปิดที่หน้าทุนถือเป็น Win เล็กๆ
            } else if (currentPrice >= order.tp) {
                isClosed = true; status = 'WIN'; reason = 'Hit TP';
                finalClosePrice = currentPrice + getTpSlippage(); // TP Slippage
                pnl = (finalClosePrice - order.entry) * lotSize * 100;
            }
        } else if (order.action === 'SELL') {
            // 1. เช็คเลื่อนบังทุน (BE)
            if (order.be && currentPrice <= order.be && order.sl > order.entry) {
                order.sl = order.entry - 0.5;
                console.log(`🛡️ [Break Even] ไม้ ${order.id} ขยับ SL บังทุนที่ ${order.sl.toFixed(2)}`);
                updateOrderInSheet(order.id, { Status: 'BREAKEVEN', SL_Price: order.sl }).catch(() => {});
                sendTelegramMessage(`🛡️ <b>ขยับ SL บังทุน (BE)</b>\n🆔 ${order.id}\n📍 SL ใหม่: ${order.sl.toFixed(2)}`).catch(() => {});
            }

            // 2. เช็ค SL / TP
            if (currentPrice >= order.sl) {
                isClosed = true; status = 'LOSS'; reason = 'Hit SL';
                const isBE = (order.sl === order.entry - 0.5);
                const slip = isBE ? 0 : getSlippage();
                finalClosePrice = currentPrice + slip;
                pnl = (order.entry - finalClosePrice) * lotSize * 100;
                if (isBE) { status = 'WIN'; reason = 'Hit BE (Safe)'; }
            } else if (currentPrice <= order.tp) {
                isClosed = true; status = 'WIN'; reason = 'Hit TP';
                finalClosePrice = currentPrice + getTpSlippage(); // TP Slippage
                pnl = (order.entry - finalClosePrice) * lotSize * 100;
            }
        }

        if (isClosed) {
            portfolioBalance += pnl;
            console.log(`[Circuit Breaker] ปิดไม้ ${order.id} | เหตุผล: ${reason} | PnL: $${pnl.toFixed(2)} | Balance: $${portfolioBalance.toFixed(2)}`);
            
            // ลบออกจากคิวติดตาม
            activeOrders.splice(i, 1);
            
            // อัปเดตลง Google Sheets (Fire-and-Forget)
            updateOrderInSheet(order.id, {
                Status: status,
                Close_Price: finalClosePrice,
                PnL: pnl.toFixed(2),
                Reason: reason
            });

            // แจ้งเตือน Telegram
            const msg = `
🚨 <b>Paper Trading: ปิดออเดอร์</b> 🚨
🆔 <b>ID:</b> ${order.id}
💡 <b>Action:</b> ${order.action}
🚪 <b>เข้าที่:</b> ${order.entry.toFixed(2)}
🛑 <b>ปิดที่:</b> ${finalClosePrice.toFixed(2)}
📊 <b>ผลลัพธ์:</b> ${status === 'WIN' ? '✅ ชนะ' : '❌ แพ้'} (${reason})
💵 <b>PnL (จำลอง):</b> <b>$${pnl.toFixed(2)}</b>
            `.trim();
            sendTelegramMessage(msg).catch(e => console.error("Telegram PnL Notify Error:", e.message));
        }
    }
}

export function addOrderToTracker(order) {
    activeOrders.push(order);
    console.log(`🎯 [Tracker] เพิ่มออเดอร์ ${order.id} เข้าสู่ระบบ Circuit Breaker แล้ว`);
}
