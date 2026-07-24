import WebSocket from 'ws';

/**
 * Tracker Bot (Circuit Breaker)
 * หน้าที่: เกาะติดราคา Tick แบบ Real-time และทำหน้าที่เป็น Circuit Breaker 
 * คอยเช็คว่าราคาปัจจุบันชน SL, TP หรือจุดตั้ง BE ของออเดอร์ที่เปิดอยู่หรือไม่
 */

let trackerSocket = null;
let activeOrders = []; // เก็บออเดอร์ที่ได้มาจาก Scout Bot หรือ Google Sheets

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

function checkCircuitBreaker(currentPrice) {
    if (activeOrders.length === 0) return;

    activeOrders.forEach(order => {
        if (order.action === 'BUY') {
            if (currentPrice <= order.sl) {
                console.log(`🛑 [Circuit Breaker] ราคา ${currentPrice} ชน SL ของไม้ BUY!`);
            } else if (currentPrice >= order.tp) {
                console.log(`💰 [Circuit Breaker] ราคา ${currentPrice} ชน TP ของไม้ BUY!`);
            }
        } else if (order.action === 'SELL') {
            if (currentPrice >= order.sl) {
                console.log(`🛑 [Circuit Breaker] ราคา ${currentPrice} ชน SL ของไม้ SELL!`);
            } else if (currentPrice <= order.tp) {
                console.log(`💰 [Circuit Breaker] ราคา ${currentPrice} ชน TP ของไม้ SELL!`);
            }
        }
    });
}

export function addOrderToTracker(order) {
    activeOrders.push(order);
    console.log(`➕ เพิ่มออเดอร์เข้า Tracker: ${order.action} @ ${order.entry} (SL: ${order.sl}, TP: ${order.tp})`);
}
