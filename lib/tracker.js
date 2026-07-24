import WebSocket from 'ws';
import { updateOrderInSheet } from './sheets.js';
import { sendTelegramMessage } from './telegram.js';

/**
 * Tracker Bot (Circuit Breaker)
 * หน้าที่: เกาะติดราคา Tick แบบ Real-time และทำหน้าที่เป็น Circuit Breaker 
 * คอยเช็คว่าราคาปัจจุบันชน SL, TP หรือจุดตั้ง BE ของออเดอร์ที่เปิดอยู่หรือไม่
 */

let trackerSocket = null;
export let activeOrders = []; // เก็บออเดอร์ที่ได้มาจาก Scout Bot หรือ Google Sheets
export let portfolioBalance = 100.00; // Mock Initial Balance

export function getPortfolioState() {
    return {
        balance: portfolioBalance,
        activeOrders: activeOrders
    };
}
export function startTracker(initialOrders = [], initialBalance = 100.00) {
    // 1. นำข้อมูลออเดอร์ค้างจากรอบที่แล้วกลับเข้า Memory
    portfolioBalance = initialBalance;
    initialOrders.forEach(order => {
        if (!activeOrders.find(o => o.id === order.id)) {
            activeOrders.push(order);
        }
    });

    console.log(`🛡️ Tracker Bot กำลังเชื่อมต่อ WebSocket... (เฝ้าระวัง ${activeOrders.length} ไม้)`);
    trackerSocket = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

    trackerSocket.on('open', () => {
        console.log('✅ Tracker Bot เชื่อมต่อสำเร็จ! กำลังเฝ้าดู XAUUSD (Tick-by-tick)');
        trackerSocket.send(JSON.stringify({
            ticks: 'frxXAUUSD',
            subscribe: 1
        }));
    });

    trackerSocket.on('message', (data) => {
        try {
            const response = JSON.parse(data.toString());
            if (response.msg_type === 'tick' && response.tick) {
                const price = parseFloat(response.tick.quote);
                checkCircuitBreaker(price);
            }
        } catch (e) {
            console.error("Tracker Parse Error:", e.message);
        }
    });

    trackerSocket.on('close', () => {
        console.log('⚠️ Tracker Bot หลุดการเชื่อมต่อ จะพยายามเชื่อมใหม่ใน 5 วินาที...');
        setTimeout(startTracker, 5000);
    });
}

async function checkCircuitBreaker(currentPrice) {
    if (activeOrders.length === 0) return;

    for (let i = activeOrders.length - 1; i >= 0; i--) {
        const order = activeOrders[i];
        let isClosed = false;
        let status = '';
        let reason = '';
        let pnl = 0;
        let finalClosePrice = currentPrice;
        const lotSize = 0.01;

        // จำลอง Slippage (0.2 ถึง 0.5 ดอลลาร์) เวลาโดนลากไปชน SL
        const getSlippage = () => (Math.random() * 0.3 + 0.2); 

        if (order.action === 'BUY') {
            // 1. เช็คเลื่อนบังทุน (BE)
            if (order.be && currentPrice >= order.be && order.sl < order.entry) {
                order.sl = order.entry + 0.5; // ขยับ SL เหนือทุนนิดนึง (กัน Spread)
                console.log(`🛡️ [Break Even] ไม้ ${order.id} ขยับ SL บังทุนที่ ${order.sl.toFixed(2)}`);
                updateOrderInSheet(order.id, { Status: 'BREAKEVEN' }).catch(() => {});
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
                finalClosePrice = currentPrice;
                pnl = (finalClosePrice - order.entry) * lotSize * 100;
            }
        } else if (order.action === 'SELL') {
            // 1. เช็คเลื่อนบังทุน (BE)
            if (order.be && currentPrice <= order.be && order.sl > order.entry) {
                order.sl = order.entry - 0.5;
                console.log(`🛡️ [Break Even] ไม้ ${order.id} ขยับ SL บังทุนที่ ${order.sl.toFixed(2)}`);
                updateOrderInSheet(order.id, { Status: 'BREAKEVEN' }).catch(() => {});
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
                finalClosePrice = currentPrice;
                pnl = (order.entry - finalClosePrice) * lotSize * 100;
            }
        }

        if (isClosed) {
            portfolioBalance += pnl;
            console.log(`[Circuit Breaker] ปิดไม้ ${order.id} | เหตุผล: ${reason} | PnL: $${pnl.toFixed(2)} | Balance: $${portfolioBalance.toFixed(2)}`);
            
            // ลบออกจากคิวติดตาม
            activeOrders.splice(i, 1);
            
            // อัปเดตลง Google Sheets
            await updateOrderInSheet(order.id, {
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
