import { fetchDerivMultiCandles } from './deriv.js';
import { analyzeTrading } from './gemini.js';
import { analyzeTradingWithGroq } from './groq.js';
import { sendTelegramMessage } from './telegram.js';
import { sanitizeForTelegram, splitTelegramMessage, fetchWithRetry, escapeHtml } from './utils.js';
import { getUpcomingHighImpactNews } from './news.js';
import { logOrderToSheet } from './sheets.js';
import { addOrderToTracker, activeOrders, getPortfolioState } from './tracker.js';

function getMarketSession() {
    const hour = new Date().getUTCHours();
    if (hour >= 13 && hour <= 21) return "🇺🇸 New York Session (ความผันผวนสูงระวังข่าว)";
    if (hour >= 7 && hour <= 15) return "🇬🇧 London Session (เริ่มมีเทรนด์ชัดเจน)";
    if (hour >= 23 || hour <= 6) return "🇯🇵 Asian Session (มักจะ Sideway วิ่งเอื่อย)";
    return "🇦🇺 Sydney / Transition (ช่วงเปลี่ยนผ่านตลาด)";
}

// ตรวจสอบว่าอยู่ในฤดูร้อนของอเมริกาหรือไม่ (Daylight Saving Time)
export function isUSDST(date = new Date()) {
    const nyTime = new Date(date.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const utcTime = new Date(date.toLocaleString("en-US", {timeZone: "UTC"}));
    const diffHours = Math.round((utcTime - nyTime) / (1000 * 60 * 60));
    return diffHours === 4; // ถ้าต่างกัน 4 ชม. แปลว่าเป็นหน้าร้อน (EDT = GMT-4)
}

// ตรวจสอบว่าตลาดปิดอยู่หรือไม่ (เสาร์-อาทิตย์)
export function isMarketClosed(date = new Date()) {
    const day = date.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    const hour = date.getUTCHours();
    
    const closeHour = isUSDST(date) ? 21 : 22; // หน้าร้อนปิด 21:00 UTC, หน้าหนาวปิด 22:00 UTC

    // ตลาดทองคำปิด: วันศุกร์ถึงวันอาทิตย์ (ตามเวลาปิด)
    if (day === 6) return true; // เสาร์ทั้งวัน (ปิด)
    if (day === 0 && hour < closeHour) return true; // อาทิตย์ก่อนตลาดเปิด (ปิด)
    if (day === 5 && hour >= closeHour) return true; // ศุกร์หลังตลาดปิด (ปิด)
    
    return false;
}

// ตรวจสอบช่วงเวลา Spread ถ่าง (Rollover)
export function isRollover(date = new Date()) {
    const hour = date.getUTCHours();
    const min = date.getUTCMinutes();
    const closeHour = isUSDST(date) ? 21 : 22;
    
    // ช่วงเวลาข้ามวัน (ก่อนปิด 5 นาที ถึง หลังปิด 15 นาที) สภาพคล่องจะแห้ง Spread ถ่าง
    // หน้าร้อน: 20:55 - 21:15 UTC | หน้าหนาว: 21:55 - 22:15 UTC
    if ((hour === closeHour - 1 && min >= 55) || (hour === closeHour && min <= 15)) {
        return true;
    }
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

        // 0.1.5 เช็คช่วง Rollover Spread ถ่าง
        if (isRollover() && !testMode) {
            console.log('🚫 [Trade Blackout Zone] อยู่ในช่วงข้ามวัน (Rollover) สภาพคล่องต่ำ Spread ถ่าง ข้ามการเทรดเพื่อหลีกเลี่ยง Stop Hunt');
            return;
        }

        // 0.2 เช็คระบบว่ามีออเดอร์ค้างอยู่หรือไม่ (เทรดทีละ 1 ไม้แทนการติด Cooldown 1 ชม.)
        if (!testMode && activeOrders.length > 0) {
            console.log(`⏳ ระบบมีออเดอร์ค้างอยู่ (${activeOrders.length} ไม้) บอทจะรอจนกว่าจะปิดไม้เดิมเสร็จเพื่อไม่ให้ Overtrade...`);
            return;
        }

        // 0.3 Margin Call Protection (เงินทุนต่ำเกินไป)
        const currentBalance = getPortfolioState().balance;
        if (!testMode && currentBalance < 5) {
            console.log(`💀 [Margin Call] พอร์ตแตกหรือมีเงินทุนไม่พอเทรด (Balance: $${currentBalance.toFixed(2)}) บอทจะหยุดทำงานเพื่อป้องกันความเสียหาย...`);
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

        // 🛡️ News Hard Stop (ระบบเบรกฉุกเฉินตอนข่าวแดง)
        if (newsSummary.includes('🔴 High Impact') || newsSummary.includes('ข่าวแดง')) {
            console.log(`🛑 [News Hard Stop] ตรวจพบข่าวแดงแรงจัด บอทจะหยุดเทรดชั่วคราวเพื่อความปลอดภัย 100%`);
            botState.isRunning = false;
            return;
        }

        // 2. Scout Logic v2: Active Tracker (4 เงื่อนไข)
        // ============================================================
        const triggerReasons = [];
        const price = m15Data.price;

        // 1️⃣ ยุบรวม Momentum (RSI + MACD) เป็นปัจจัยเดียว (Hidden Correlation Fix)
        let momentumScore = 0; // -2 ถึง +2
        let momentumDesc = [];
        
        if (m15Data.rsi > 65) { momentumScore -= 1; momentumDesc.push(`RSI=${m15Data.rsi} (Overbought)`); }
        if (m15Data.rsi < 35) { momentumScore += 1; momentumDesc.push(`RSI=${m15Data.rsi} (Oversold)`); }
        
        if (m15Data.macd) {
            if (m15Data.macd.state.includes('Golden Cross') || m15Data.macd.state.includes('ขาขึ้นแข็งแกร่ง')) { momentumScore += 1; momentumDesc.push('MACD หนุนขึ้น'); }
            if (m15Data.macd.state.includes('Death Cross') || m15Data.macd.state.includes('ขาลงแข็งแกร่ง')) { momentumScore -= 1; momentumDesc.push('MACD กดลง'); }
        }

        if (momentumScore >= 2) triggerReasons.push(`🔥 แรงซื้อรุนแรง: ${momentumDesc.join(' + ')}`);
        else if (momentumScore <= -2) triggerReasons.push(`🩸 แรงขายรุนแรง: ${momentumDesc.join(' + ')}`);
        else if (momentumScore === 1) triggerReasons.push(`📈 โมเมนตัมเอียงไปทางซื้อ: ${momentumDesc.join(' + ')}`);
        else if (momentumScore === -1) triggerReasons.push(`📉 โมเมนตัมเอียงไปทางขาย: ${momentumDesc.join(' + ')}`);
        else if (momentumDesc.length > 0) triggerReasons.push(`⚖️ โมเมนตัมผสมผสาน: ${momentumDesc.join(' และ ')}`);

        // 2️⃣ ราคาทดสอบ Fibonacci สำคัญ (Tolerance = ATR × 0.8 เพื่อรับแรงกระแทกไส้เทียน)
        if (m15Data.fibo && m15Data.atr) {
            const tolerance = m15Data.atr * 0.8;
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
            console.log('💤 ข้ามการวิเคราะห์รอบนี้ เนื่องจากยังไม่เข้าเงื่อนไขใดเลย:');
            console.log(`   - 📊 RSI: ${m15Data.rsi} (ยังไม่อยู่ในเขตอันตราย <35 หรือ >65)`);
            if (m15Data.fibo && m15Data.atr) {
                const tol = (m15Data.atr * 0.3).toFixed(2);
                console.log(`   - 📉 Fibo: ราคา $${price} ยังไม่ชนแนว 50% ($${m15Data.fibo.level_50_0}) หรือ 61.8% ($${m15Data.fibo.level_61_8}) ในระยะ ±$${tol}`);
            }
            console.log(`   - 🕯️ Pattern: ${m15Data.candlestick_pattern}`);
            console.log(`   - 📈 Breakout: ${m15Data.breakout}`);
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
ตอบกลับเฉพาะรูปแบบ JSON ที่กำหนด ห้ามมีข้อความอื่นนอกกรอบ JSON เด็ดขาด (ยกเว้นแท็ก <think>)`;

        // 4. ประกอบ Prompt ขั้นเทพ (แบบเล่าเรื่อง + Chain of Thought)
        const h1Trend = h1Data.ema_fast > h1Data.ema_slow ? "ขาขึ้น" : "ขาลง";

        // สร้างกรอบคิดวิเคราะห์ตามสัญญาณที่ปลุกแบบจัดกลุ่ม (Cluster)
        const guides = [
            `[Cluster 1: Momentum] *ระวัง: RSI และ MACD มาจากสูตรคณิตศาสตร์ที่อิงราคาปิดเหมือนกัน อย่าหลงกลว่าเป็นสัญญาณยืนยันซึ่งกันและกัน (Hidden Correlation) ใช้ดูแค่โมเมนตัมหนุนเทรนด์เท่านั้น`,
            `[Cluster 2: Structure & Action] ให้น้ำหนักสูงสุด: ราคาเบรคหลอกหรือไม่? แพทเทิร์นแท่งเทียนเกิดที่แนวรับ/ต้านสำคัญและสอดคล้องกับโครงสร้าง 24H หรือไม่?`,
            `[Cluster 3: Value Zone] ราคาอยู่ใกล้ตัวเลขจิตวิทยาหรือ Fibo ที่มีนัยสำคัญหรือไม่? ถ้าระยะห่างน้อยกว่า ATR ให้ระวังการสวิงตัว`
        ];

        const prompt = `
            สรุปสภาวะตลาดทองคำ ณ ปัจจุบัน:
            - ภาพใหญ่ (H1): เป็นเทรนด์${h1Trend} (EMA9=${h1Data.ema_fast}, EMA21=${h1Data.ema_slow}) ความแรงเทรนด์ ADX = ${h1Data.adx || 'N/A'}
            - โครงสร้างราคา (M15 รอบ 24 ชม.): ${m15Data.market_structure}
            - ภาพย่อย (M15): ราคาล่าสุด $${m15Data.price} สถานะคือ ${m15Data.breakout}
            - ตัวเลขจิตวิทยา: ${m15Data.round_number}
            - รูปแบบกราฟ: เกิด ${m15Data.candlestick_pattern}
            - โมเมนตัม (RSI): RSI = ${m15Data.rsi}, ความผันผวน ATR = ${m15Data.atr}
            - โมเมนตัม (MACD): Line = ${m15Data.macd?.macd}, Signal = ${m15Data.macd?.signal}, Hist = ${m15Data.macd?.hist} (${m15Data.macd?.state})
            - โซนเฝ้าระวัง: แนวรับ/ต้าน Fibo (รอบ 24 ชม.) อยู่ที่ $${m15Data.fibo?.level_50_0} ถึง $${m15Data.fibo?.level_61_8}
            - สถานการณ์ภายนอก: อยู่ในช่วง ${session} และ ${newsSummary.includes('ไม่มีข่าว') ? 'ไม่มีข่าวรุนแรง' : 'มีข่าวแดงต้องระวัง'}
            
            🚨 เหตุผลที่ระบบปลุกคุณขึ้นมาวิเคราะห์ (ข้อมูลดิบ):
            ${triggerReasons.length > 0 ? triggerReasons.map((r, i) => `${i+1}. ${r}`).join('\n            ') : '1. [Test Mode] ให้วิเคราะห์สภาวะตลาดปัจจุบัน'}
            
            คำสั่งบังคับ (ให้ออกแบบการตอบเป็น 2 ส่วนดังนี้):

            ส่วนที่ 1: กระบวนการคิด (ห่อหุ้มด้วยแท็ก <think> และ </think>)
            <think>
            อธิบายเหตุผลการตัดสินใจของคุณ (ความยาวไม่เกิน 6 บรรทัด)
            - อย่าดูจำนวนสัญญาณที่เยอะ เพราะอินดิเคเตอร์บางตัวมาจากสูตรคณิตศาสตร์เดียวกัน
            - วิเคราะห์เป็น Cluster: ${guides.join(' | ')}
            - สรุป: พิจารณา Market Structure ควบคู่กับทั้ง 3 Cluster ถ้าสัญญาณขัดแย้งกันให้ WAIT ทันที
            </think>

            ส่วนที่ 2: บทสรุป (ตอบเป็น JSON Format เท่านั้น ห้ามพิมพ์ข้อความอื่นต่อท้าย)
            ระบบบอทจะเป็นคนคำนวณ SL/TP ทางคณิตศาสตร์เอง คุณมีหน้าที่แค่วิเคราะห์และบอกทิศทางเท่านั้น!
            {
              "reasoning": "เหตุผลสั้นๆ 1 บรรทัด",
              "action": "BUY หรือ SELL หรือ WAIT"
            }
        `;

        // 5. ให้ AI วิเคราะห์ (ให้ Groq 70b เป็นตัวหลัก, Gemini 3.5 เป็นสำรอง)
        let aiResponse;
        let usedFallback = false;
        const aiStartTime = Date.now();
        try {
            aiResponse = await fetchWithRetry(() => analyzeTradingWithGroq(prompt, systemInstruction));
        } catch (groqErr) {
            console.warn(`[Fallback] Groq ล่มหรือติดลิมิต (${groqErr.message})... กำลังสลับไปใช้ Gemini AI สำรอง!`);
            try {
                // ให้ Gemini ลองพยายามสัก 3 รอบถ้าพัง
                aiResponse = await fetchWithRetry(() => analyzeTrading(prompt, systemInstruction), 3);
                usedFallback = true;
            } catch (geminiErr) {
                throw new Error(`ทั้ง Groq และ Gemini ล่มทั้งหมด: ${geminiErr.message}`);
            }
        }

        if (usedFallback) {
            aiResponse += '\n\n*(วิเคราะห์โดย 🧠 Gemini Fallback AI เนื่องจาก Groq ขัดข้อง)*';
        }

        console.log('\n--- 🧠 AI Reasoning & Output ---\n' + aiResponse + '\n---------------------------------\n');

        // 5.5 Stale Entry Protection (ดักจับความหน่วง AI)
        const llmLatency = Date.now() - aiStartTime;
        if (llmLatency > 15000) { // ถ้านานเกิน 15 วินาที ถือว่าสัญญาณเก่า (Stale)
            console.log(`⏱️ [Stale Entry Protection] ยกเลิกออเดอร์! AI ใช้เวลาคิดนานเกินไป (${(llmLatency/1000).toFixed(1)} วิ) ราคาปัจจุบันอาจวิ่งไปไกลแล้ว เกิดความเสี่ยง Slippage สูง`);
            botState.isRunning = false;
            return;
        }

        // 6. แยก JSON ออกจาก <think> และตรวจสอบค่า
        let jsonStr = aiResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        // ลบ markdown codeblock ถ้ามี
        if (jsonStr.startsWith("```json")) {
            jsonStr = jsonStr.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        } else if (jsonStr.startsWith("```")) {
            jsonStr = jsonStr.replace(/^```\n?/, '').replace(/\n?```$/, '');
        }

        let parsedData = null;
        try {
            parsedData = JSON.parse(jsonStr);
        } catch (e) {
            console.error("❌ ไม่สามารถแปลง AI Response เป็น JSON ได้:", jsonStr);
            throw new Error("AI ตอบกลับมาไม่ตรงฟอร์แมต JSON");
        }

        // 7. ตรวจสอบว่า AI แนะนำให้ WAIT หรือไม่
        if (parsedData.action === 'WAIT' || !['BUY', 'SELL'].includes(parsedData.action)) {
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
                reasoning: parsedData.reasoning
            };
            console.log(`✋ AI แนะนำให้ WAIT: ${parsedData.reasoning}`);
            botState.isRunning = false;
            return;
        }

        // 8. คำนวณ Risk Management (Math-based SL/TP/BE)
        const spreadBuffer = 0.5; // เผื่อ Spread 50 pips (Cost of Entry)
        
        // จำลองเสียเปรียบ Spread ตอนเข้าออเดอร์ทันที
        let entryPrice = parseFloat(m15Data.price);
        if (parsedData.action === 'BUY') entryPrice += spreadBuffer; // ซื้อแพง
        else if (parsedData.action === 'SELL') entryPrice -= spreadBuffer; // ขายถูก

        const currentAtr = m15Data.atr || 2.0; // ค่า Default ถ้าหา ATR ไม่ได้
        
        let slPrice = 0;
        let tpPrice = 0;
        let bePrice = 0;

        // คำนวณระยะ SL และชนเพดานขั้นต่ำ (SL Floor) ป้องกัน ATR ต่ำผิดปกติจนโดน Spread กินฟรี
        const slDistanceRaw = currentAtr * 1.5;
        const slDistance = Math.max(slDistanceRaw, 2.5); // บังคับขั้นต่ำกว้าง 2.5 ดอลลาร์

        if (parsedData.action === 'BUY') {
            slPrice = entryPrice - slDistance;
            tpPrice = entryPrice + (slDistance * 1.5); // Risk:Reward 1:1.5
            bePrice = entryPrice + spreadBuffer + (currentAtr * 0.8); // บังทุน
        } else if (parsedData.action === 'SELL') {
            slPrice = entryPrice + slDistance;
            tpPrice = entryPrice - (slDistance * 1.5); // Risk:Reward 1:1.5
            bePrice = entryPrice - spreadBuffer - (currentAtr * 0.8); // บังทุน
        }

        // Format ทศนิยม 2 ตำแหน่ง
        const formatPrice = (p) => p.toFixed(2);

        // 9. จัดหน้าตาข้อความส่งเข้า Telegram
        let messageToTelegram = `
🎯 <b>XAU_Sentinel AI Signal</b> 🎯
🌍 <b>แนวโน้ม:</b> ${m15Data.market_structure}
💡 <b>Action:</b> <b>${parsedData.action}</b>
📍 <b>Entry:</b> ${formatPrice(entryPrice)}
🛑 <b>SL:</b> ${formatPrice(slPrice)} (ATRx1.5)
💰 <b>TP:</b> ${formatPrice(tpPrice)} (RR 1:1.5)
🛡️ <b>BE:</b> ${formatPrice(bePrice)} (หัก Spread แล้ว)

📝 <b>เหตุผลจาก AI:</b> 
<i>${parsedData.reasoning}</i>

⚙️ <i>Math Risk Engine: ATR = ${currentAtr.toFixed(2)}</i>
        `.trim();
        
        if (usedFallback) {
            messageToTelegram += '\n\n*(🧠 รันด้วย Gemini Fallback AI)*';
        }

        const cleanMessage = sanitizeForTelegram(messageToTelegram);
        const chunks = splitTelegramMessage(cleanMessage);

        console.log('📤 กำลังส่งแผนเทรดเข้า Telegram...');
        for (const chunk of chunks) {
            await sendTelegramMessage(chunk);
            if (chunks.length > 1) await new Promise(r => setTimeout(r, 1000));
        }
        
        // 9. เพิ่มออเดอร์เข้า Paper Trading System
        const orderId = `XAU-${Date.now().toString().slice(-6)}`;
        const orderObj = {
            id: orderId,
            ts: Date.now(),
            action: parsedData.action,
            entry: entryPrice,
            sl: slPrice,
            tp: tpPrice,
            be: bePrice
        };
        
        await logOrderToSheet(orderObj);
        addOrderToTracker(orderObj);

        // 10. เริ่มนับเวลา Cooldown + บันทึก state
        lastAlertTime = Date.now();
        botState.lastAlertAt = lastAlertTime;
        botState.lastAnalysis = {
            ts: Date.now(),
            price: m15Data.price,
            rsi: m15Data.rsi,
            trend: h1Trend,
            adx: h1Data.adx,
            session,
            decision: parsedData.action,
            hasNews: !newsSummary.includes('ไม่มีข่าว'),
            triggers: triggerReasons,
            reasoning: parsedData.reasoning,
            be: bePrice
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
