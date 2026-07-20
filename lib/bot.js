import { fetchDerivMultiCandles } from './deriv.js';
import { analyzeTrading } from './gemini.js';
import { sendTelegramMessage } from './telegram.js';
import { sanitizeForTelegram, splitTelegramMessage, fetchWithRetry, escapeHtml } from './utils.js';
import { getUpcomingHighImpactNews } from './news.js';

function getMarketSession() {
    const hour = new Date().getUTCHours();
    if (hour >= 13 && hour <= 21) return "🇺🇸 New York Session (ความผันผวนสูงระวังข่าว)";
    if (hour >= 7 && hour <= 15) return "🇬🇧 London Session (เริ่มมีเทรนด์ชัดเจน)";
    if (hour >= 23 || hour <= 6) return "🇯🇵 Asian Session (มักจะ Sideway วิ่งเอื่อย)";
    return "🇦🇺 Sydney / Transition (ช่วงเปลี่ยนผ่านตลาด)";
}

// ตรวจสอบว่าตลาดปิดอยู่หรือไม่ (เสาร์-อาทิตย์)
export function isMarketClosed(date = new Date()) {
    const day = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const hour = date.getUTCHours();

    // ตลาดทองคำปิด: วันศุกร์ 21:00 UTC ถึง วันอาทิตย์ 22:00 UTC
    if (day === 6) return true; // เสาร์ทั้งวัน (ปิด)
    if (day === 0 && hour < 22) return true; // อาทิตย์ก่อน 22:00 UTC (ปิด)
    if (day === 5 && hour >= 22) return true; // ศุกร์หลัง 22:00 UTC (ปิด)
    
    return false;
}

const INTERVAL_MS  = 15 * 60 * 1000;
const COOLDOWN_MS  =  1 * 60 * 60 * 1000;
const CANDLE_DELAY =       5 * 1000; // 5 วิ หลังแท่งปิด (ตรงกับ server.js)

let lastAlertTime = 0;

/**
 * คำนวณ timestamp ที่บอทจะรันครั้งถัดไป
 * (M15 slot ถัดไป + 5 วิ) — ตรงกับ scheduleBot() ใน server.js
 */
function calcNextRunAt() {
    const now  = Date.now();
    const next = Math.ceil(now / INTERVAL_MS) * INTERVAL_MS;
    return next + CANDLE_DELAY;
}
const botState = {
    startedAt: Date.now(),       // เวลาที่ server เริ่มทำงาน
    lastRunAt: 0,                // timestamp รอบล่าสุดที่รัน (รวมที่ถูก skip)
    nextRunAt: 0,                // timestamp รอบถัดไป (snap ตาม M15)
    lastAlertAt: 0,              // timestamp ที่ส่ง Telegram ล่าสุด
    isRunning: false,            // กำลังประมวลผลอยู่ไหม
    lastAnalysis: null,          // ผลวิเคราะห์รอบล่าสุดที่เรียก AI จริง
};

/**
 * คำนวณ timestamp ของ M15 slot ถัดไป (:00, :15, :30, :45)
 * เพื่อให้ nextRunAt ไม่รีเซ็ตทุกครั้งที่ server restart
 */
function calcNextM15() {
    const now = Date.now();
    const slot = Math.ceil(now / INTERVAL_MS) * INTERVAL_MS;
    return slot;
}

/**
 * คืน state ปัจจุบันของบอทสำหรับ Dashboard
 */
export function getBotState() {
    const now = Date.now();
    return {
        ...botState,
        cooldownEndsAt: lastAlertTime > 0 ? lastAlertTime + COOLDOWN_MS : 0,
        isInCooldown: lastAlertTime > 0 && (now - lastAlertTime < COOLDOWN_MS),
        isMarketOpen: !isMarketClosed(),
        currentSession: getMarketSession(),
        intervalMs: INTERVAL_MS,
        cooldownMs: COOLDOWN_MS,
    };
}

/**
 * ให้ server.js set nextRunAt ทันทีตอน schedule ไม่ต้องรอให้ bot รัน
 */
export function setNextRunAt(ts) {
    botState.nextRunAt = ts;
}

export async function runScoutBot(testMode = false) {
    // อัปเดต nextRunAt ทุกครั้งที่รัน
    botState.lastRunAt = Date.now();
    botState.nextRunAt = calcNextRunAt();

    try {
        // 0.1 เช็ควันหยุด (เสาร์-อาทิตย์)
        if (isMarketClosed() && !testMode) {
            console.log('🛑 ตลาดทองคำปิดทำการ (วันหยุดเสาร์-อาทิตย์) บอทจะนอนหลับจนกว่าตลาดจะเปิด...');
            return;
        }

        const now = Date.now();
        // 0.2 เช็คระบบ Cooldown (กันแชทเด้งรัวๆ)
        if (!testMode && now - lastAlertTime < COOLDOWN_MS) {
            const remainingMins = Math.ceil((COOLDOWN_MS - (now - lastAlertTime)) / 60000);
            console.log(`⏳ ระบบอยู่ในช่วง Cooldown (พักเบรกอีก ${remainingMins} นาที) เพื่อไม่ให้สแปมแชท...`);
            return;
        }

        botState.isRunning = true;
        console.log('🤖 Scout Bot Waking up: Fetching H1 and M15 data from Deriv...');
        
        // 1. ดึงข้อมูล 2 Timeframes ผ่าน WebSocket connection เดียว (ลด overhead)
        // H1 ใช้ mode 'light' (แค่ EMA+ADX) — M15 ใช้ mode 'full' (ครบทุก Indicator)
        const [h1Data, m15Data] = await fetchWithRetry(() =>
            fetchDerivMultiCandles([
                { granularity: 3600, count: 100, mode: 'light' }, // H1
                { granularity: 900,  count: 100, mode: 'full'  }  // M15
            ])
        );
        
        const session = getMarketSession();
        const newsSummary = await getUpcomingHighImpactNews();

        console.log(`✅ MTFA fetched. H1 Price: $${h1Data.price}, M15 Price: $${m15Data.price}, Session: ${session}`);
        console.log(`📰 News: ${newsSummary.replace(/\n/g, ' ')}`);
        console.log(`📊 M15 RSI: ${m15Data.rsi}`);

        // 2. Scout Logic v2: Active Tracker (4 เงื่อนไข)
        // ============================================================
        const triggerReasons = [];
        const price = m15Data.price;

        // 1️⃣ RSI สุดโต่ง
        if (m15Data.rsi > 65) triggerReasons.push(`โมเมนตัม RSI=${m15Data.rsi} เข้าเขต Overbought (>65) อาจมีแรงเทขาย`);
        if (m15Data.rsi < 35) triggerReasons.push(`โมเมนตัม RSI=${m15Data.rsi} เข้าเขต Oversold (<35) อาจมีแรงซื้อกลับ`);

        // 2️⃣ ราคาทดสอบ Fibonacci สำคัญ (Tolerance = ATR × 0.3)
        if (m15Data.fibo && m15Data.atr) {
            const tolerance = m15Data.atr * 0.3;
            const isNear = (p, level) => Math.abs(p - level) <= tolerance;
            if (isNear(price, m15Data.fibo.level_50_0))
                triggerReasons.push(`ราคา $${price} ทดสอบ Fibo 50.0% ($${m15Data.fibo.level_50_0}) ±$${tolerance.toFixed(2)}`);
            if (isNear(price, m15Data.fibo.level_61_8))
                triggerReasons.push(`ราคา $${price} ทดสอบ Fibo 61.8% ($${m15Data.fibo.level_61_8}) ±$${tolerance.toFixed(2)}`);
        }

        // 3️⃣ Price Action กลับตัว (Pin Bar / Engulfing)
        if (!m15Data.candlestick_pattern.includes('ไม่มีรูปแบบ')) {
            triggerReasons.push(`พบรูปแบบแท่งเทียน: ${m15Data.candlestick_pattern}`);
        }

        // 4️⃣ Breakout (ทะลุกรอบ Swing High/Low)
        if (!m15Data.breakout.includes('Sideway')) {
            triggerReasons.push(`ราคา${m15Data.breakout}`);
        }

        // ── ถ้าไม่มีเหตุผลเลย = ตลาดน่าเบื่อ ข้ามไป ──
        if (!testMode && triggerReasons.length === 0) {
            console.log('💤 ไม่พบสัญญาณ (RSI/Fibo/Pattern/Breakout) ข้ามการวิเคราะห์...');
            botState.isRunning = false;
            return;
        }

        if (testMode) {
            console.log('🛠️ [Test Mode] ข้ามการเช็ค Scout Logic และเรียก AI วิเคราะห์โดยตรง...');
        } else {
            console.log(`🔔 พบ ${triggerReasons.length} สัญญาณ:`);
            triggerReasons.forEach(r => console.log(`   → ${r}`));
        }

        // 3. สร้าง System Instruction
        const systemInstruction = `คุณคือ AI ผู้จัดการกองทุน (Fund Manager) วิเคราะห์ทองคำ (XAUUSD)
หน้าที่ของคุณคือรับข้อมูลตลาด และต้อง "คิดวิเคราะห์ทีละขั้นตอน (Chain of Thought)" ก่อนตัดสินใจ BUY, SELL หรือ WAIT
ตอบเป็นภาษาไทย ใช้ HTML format (<b>, <i>, <pre>) ห้ามใช้ Markdown ** เด็ดขาด`;

        // 4. ประกอบ Prompt ขั้นเทพ (แบบเล่าเรื่อง + Chain of Thought)
        const h1Trend = h1Data.ema_fast > h1Data.ema_slow ? "ขาขึ้น" : "ขาลง";

        // สร้างกรอบคิดวิเคราะห์ตามสัญญาณที่ปลุก
        const guides = [];
        const hasRSI      = triggerReasons.some(t => t.includes('RSI'));
        const hasFibo     = triggerReasons.some(t => t.includes('Fibo'));
        const hasPattern  = triggerReasons.some(t => t.includes('แท่งเทียน'));
        const hasBreakout = triggerReasons.some(t => t.includes('ทะลุ') || t.includes('หลุด'));

        if (hasRSI || triggerReasons.length === 0) guides.push(
            `[RSI สุดโต่ง] ราคาลงมาชนแนวรับ/ขึ้นไปชนแนวต้านไหม? เทรนด์ใหญ่ H1 สวนทางไหม? ถ้า RSI สุดโต่งแต่เทรนด์สวน ให้ระวัง "จับมีดตก"`
        );
        if (hasFibo) guides.push(
            `[Fibo Test] ราคาเด้งจากแนว Fibo หรือกำลังทะลุผ่าน? มีแท่งเทียนยืนยันการกลับตัวที่แนวนี้ไหม? ถ้าไม่มีก็ยังไม่ควรเข้า`
        );
        if (hasPattern) guides.push(
            `[Price Action] Pattern เกิดที่แนวรับ/ต้านสำคัญไหม? หรือเกิดกลางทาง (ไม่น่าเชื่อถือ)? Pattern สอดคล้องกับเทรนด์ H1 ไหม?`
        );
        if (hasBreakout) guides.push(
            `[Breakout] Breakout จริงหรือหลอก (Fakeout)? ADX แรงพอจะ follow ไหม? ราคาปิดแท่งยืนยันเหนือ/ใต้แนวที่ทะลุหรือยัง?`
        );

        const prompt = `
            สรุปสภาวะตลาดทองคำ ณ ปัจจุบัน:
            - ภาพใหญ่ (H1): เป็นเทรนด์${h1Trend} (EMA9=${h1Data.ema_fast}, EMA21=${h1Data.ema_slow}) ความแรงเทรนด์ ADX = ${h1Data.adx || 'N/A'}
            - ภาพย่อย (M15): ราคาล่าสุดอยู่ที่ $${m15Data.price} สถานะคือ ${m15Data.breakout}
            - รูปแบบกราฟ: เกิด ${m15Data.candlestick_pattern}
            - โมเมนตัม: RSI = ${m15Data.rsi}, ความผันผวน ATR = ${m15Data.atr}
            - โซนเฝ้าระวัง: แนวรับ/ต้าน Fibo อยู่ที่ $${m15Data.fibo?.level_50_0} ถึง $${m15Data.fibo?.level_61_8}
            - สถานการณ์ภายนอก: อยู่ในช่วง ${session} และ ${newsSummary.includes('ไม่มีข่าว') ? 'ไม่มีข่าวรุนแรง' : 'มีข่าวแดงต้องระวัง'}
            
            🚨 เหตุผลที่ระบบปลุกคุณขึ้นมาวิเคราะห์ (พบ ${triggerReasons.length} สัญญาณ):
            ${triggerReasons.length > 0 ? triggerReasons.map((r, i) => `${i+1}. ${r}`).join('\n            ') : '1. [Test Mode] ให้วิเคราะห์สภาวะตลาดปัจจุบัน'}
            
            คำสั่งบังคับ (ให้ออกแบบการตอบเป็น 2 ส่วนดังนี้):

            ส่วนที่ 1: กระบวนการคิด (ห่อหุ้มด้วยแท็ก <think> และ </think>)
            <think>
            วิเคราะห์ตามกรอบนี้ทีละข้อ: 
            ${guides.map((g, i) => `${i+1}. ${g}`).join('\n            ')}
            สุดท้าย: สรุปว่าสัญญาณทั้งหมดสอดคล้องกัน (Confluence) กี่ข้อจากทั้งหมด?
            ถ้าสอดคล้องกัน ≥ 2 ข้อ = ให้สัญญาณ, ถ้าขัดแย้ง = WAIT
            </think>

            ส่วนที่ 2: บทสรุปแผนการเทรด (สั้น กระชับ กวาดตา 2 วินาทีแล้วเข้าใจ)
            1. 🌍 แนวโน้ม: (บอกสั้นๆ)
            2. 🎯 โซนแนวรับ/ต้าน: (อ้างอิง Fibo)
            3. 💡 แผนการเทรด: BUY / SELL / WAIT (จุดเข้า, SL, TP)
            4. 🛡️ การจัดการความเสี่ยง: (บังทุน/แบ่งเก็บกำไร)
        `;

        // 5. ให้ Gemini วิเคราะห์
        const aiResponse = await fetchWithRetry(() => analyzeTrading(prompt, systemInstruction));
        console.log('\n--- 🧠 AI Reasoning & Output ---\n' + aiResponse + '\n---------------------------------\n');

        // 6. ตรวจสอบว่า AI แนะนำให้ WAIT หรือไม่
        if (aiResponse.includes('WAIT') || aiResponse.includes('WAIT)')) {
            // บันทึก analysis ลง state แม้จะ WAIT
            botState.lastAnalysis = {
                ts: Date.now(),
                price: m15Data.price,
                rsi: m15Data.rsi,
                trend: h1Trend,
                adx: h1Data.adx,
                session,
                decision: 'WAIT',
                hasNews: !newsSummary.includes('ไม่มีข่าว'),
                triggers: triggerReasons,
            };
            console.log('✋ AI แนะนำให้ WAIT (รอดูท่าที) ระบบจะไม่ส่งแจ้งเตือนเข้า Telegram เพื่อลดความรำคาญ');
            botState.isRunning = false;
            return;
        }

        // 7. ส่งเข้า Telegram
        const cleanMessage = sanitizeForTelegram(aiResponse);
        const chunks = splitTelegramMessage(cleanMessage);

        console.log('📤 กำลังส่งแผนเทรดเข้า Telegram...');
        for (const chunk of chunks) {
            await sendTelegramMessage(chunk);
            if (chunks.length > 1) await new Promise(r => setTimeout(r, 1000));
        }
        
        // 8. เริ่มนับเวลา Cooldown + บันทึก state
        lastAlertTime = Date.now();
        botState.lastAlertAt = lastAlertTime;
        botState.lastAnalysis = {
            ts: Date.now(),
            price: m15Data.price,
            rsi: m15Data.rsi,
            trend: h1Trend,
            adx: h1Data.adx,
            session,
            decision: aiResponse.includes('BUY') ? 'BUY' : 'SELL',
            hasNews: !newsSummary.includes('ไม่มีข่าว'),
            triggers: triggerReasons,
        };
        console.log('✅ ส่งแผนเทรดสำเร็จ! (เริ่มนับ Cooldown 1 ชั่วโมง)');

    } catch (error) {
        console.error("❌ Error processing Scout bot:", error.message || error);
        try {
            const errorMsg = `⚠️ <b>Hybrid Bot Failed</b>\n<pre>${escapeHtml(String(error.message || error))}</pre>`;
            await sendTelegramMessage(errorMsg);
        } catch (notifyErr) {
            console.error("Failed to send error notification:", notifyErr.message || notifyErr);
        }
    } finally {
        botState.isRunning = false;
    }
}
