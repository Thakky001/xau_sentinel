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
export function startTracker() {
    console.log('🛡️ Tracker Bot กำลังเชื่อมต่อ WebSocket (Tick Stream)...');
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
        const lotSize = 0.01;

        if (order.action === 'BUY') {
            if (currentPrice <= order.sl) {
                isClosed = true; status = 'LOSS'; reason = 'Hit SL';
                pnl = (currentPrice - order.entry) * lotSize * 100;
            } else if (currentPrice >= order.tp) {
                isClosed = true; status = 'WIN'; reason = 'Hit TP';
                pnl = (currentPrice - order.entry) * lotSize * 100;
            }
        } else if (order.action === 'SELL') {
            if (currentPrice >= order.sl) {
                isClosed = true; status = 'LOSS'; reason = 'Hit SL';
                pnl = (order.entry - currentPrice) * lotSize * 100;
            } else if (currentPrice <= order.tp) {
                isClosed = true; status = 'WIN'; reason = 'Hit TP';
                pnl = (order.entry - currentPrice) * lotSize * 100;
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
                Close_Price: currentPrice,
                PnL: pnl.toFixed(2),
                Reason: reason
            });

            // แจ้งเตือน Telegram
            const msg = `
🚨 <b>Paper Trading: ปิดออเดอร์</b> 🚨
🆔 <b>ID:</b> ${order.id}
💡 <b>Action:</b> ${order.action}
🚪 <b>เข้าที่:</b> ${order.entry.toFixed(2)}
🛑 <b>ปิดที่:</b> ${currentPrice.toFixed(2)}
📊 <b>ผลลัพธ์:</b> ${status === 'WIN' ? '✅ ชนะ (Hit TP)' : '❌ แพ้ (Hit SL)'}
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
