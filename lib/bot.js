import { fetchDerivMultiCandles } from './deriv.js';
import { analyzeTrading } from './gemini.js';
import { analyzeTradingWithGroq } from './groq.js';
import { sendTelegramMessage } from './telegram.js';
import { sanitizeForTelegram, splitTelegramMessage, fetchWithRetry, escapeHtml } from './utils.js';
import { getUpcomingHighImpactNews, isWithinNewsBlackout } from './news.js';
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

// ตรวจสอบว่าตลาดทองคำกำลังจะปิดสุดสัปดาห์ในอีกไม่เกิน 15 นาทีหรือไม่ (เพื่อชำระบัญชี)
export function isWeekendApproaching(date = new Date()) {
    const nyTime = new Date(date.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const day = nyTime.getDay();
    const hour = nyTime.getHours();
    const minute = nyTime.getMinutes();
    // วันศุกร์ เวลา 16:45 เป็นต้นไป (ก่อนปิดตลาด 17:00)
    return (day === 5 && hour === 16 && minute >= 45);
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

        // 🛡️ News Blackout Zone (บล็อคเฉพาะช่วง ±1 ชั่วโมงรอบข่าวแดง)
        const newsBlackout = isWithinNewsBlackout();
        if (newsBlackout.isBlackout) {
            console.log(`🛑 [News Blackout] บล็อคการเทรดชั่วคราว — ${newsBlackout.reason}`);
            botState.isRunning = false;
            return;
        }

        // 2. Scout Logic v3: Multi-Gate Trigger (ต้องผ่าน 2 Cluster ถึงปลุก AI)
        // ============================================================
        const triggerReasons = [];
        const activeClusters = new Set(); // เก็บชื่อ Cluster ที่ถูกกระตุ้น
        const price = m15Data.price;

        // ── Cluster A: Momentum (RSI + MACD) ──
        let momentumScore = 0;
        let momentumDesc = [];
        
        if (m15Data.rsi > 65) { momentumScore -= 1; momentumDesc.push(`RSI=${m15Data.rsi} (Overbought)`); }
        if (m15Data.rsi < 35) { momentumScore += 1; momentumDesc.push(`RSI=${m15Data.rsi} (Oversold)`); }
        
        if (m15Data.macd) {
            if (m15Data.macd.state.includes('Golden Cross') || m15Data.macd.state.includes('ขาขึ้นแข็งแกร่ง')) { momentumScore += 1; momentumDesc.push('MACD หนุนขึ้น'); }
            if (m15Data.macd.state.includes('Death Cross') || m15Data.macd.state.includes('ขาลงแข็งแกร่ง')) { momentumScore -= 1; momentumDesc.push('MACD กดลง'); }
        }

        if (Math.abs(momentumScore) >= 1 && momentumDesc.length > 0) {
            activeClusters.add('Momentum');
            if (momentumScore >= 2) triggerReasons.push(`🔥 [Momentum] แรงซื้อรุนแรง: ${momentumDesc.join(' + ')}`);
            else if (momentumScore <= -2) triggerReasons.push(`🩸 [Momentum] แรงขายรุนแรง: ${momentumDesc.join(' + ')}`);
            else if (momentumScore === 1) triggerReasons.push(`📈 [Momentum] เอียงไปทางซื้อ: ${momentumDesc.join(' + ')}`);
            else if (momentumScore === -1) triggerReasons.push(`📉 [Momentum] เอียงไปทางขาย: ${momentumDesc.join(' + ')}`);
        }

        // ── Cluster B: Value Zone (Fibo + Round Number) ──
        if (m15Data.fibo && m15Data.atr) {
            const tolerance = m15Data.atr * 0.8;
            const isNear = (p, level) => Math.abs(p - level) <= tolerance;
            if (isNear(price, m15Data.fibo.level_50_0)) {
                activeClusters.add('ValueZone');
                triggerReasons.push(`📐 [ValueZone] ราคา $${price} ทดสอบ Fibo 50.0% ($${m15Data.fibo.level_50_0}) ±$${tolerance.toFixed(2)}`);
            }
            if (isNear(price, m15Data.fibo.level_61_8)) {
                activeClusters.add('ValueZone');
                triggerReasons.push(`📐 [ValueZone] ราคา $${price} ทดสอบ Fibo 61.8% ($${m15Data.fibo.level_61_8}) ±$${tolerance.toFixed(2)}`);
            }
        }
        if (m15Data.round_number && !m15Data.round_number.includes('ไม่มี')) {
            activeClusters.add('ValueZone');
            triggerReasons.push(`🔢 [ValueZone] ${m15Data.round_number}`);
        }

        // ── Cluster C: Structure (Candlestick Pattern + Breakout) ──
        if (!m15Data.candlestick_pattern.includes('ไม่มีรูปแบบ')) {
            activeClusters.add('Structure');
            triggerReasons.push(`🕯️ [Structure] พบรูปแบบแท่งเทียน: ${m15Data.candlestick_pattern}`);
        }
        if (!m15Data.breakout.includes('Sideway')) {
            activeClusters.add('Structure');
            triggerReasons.push(`💥 [Structure] ราคา${m15Data.breakout}`);
        }

        // ── Multi-Gate: ต้องมี >= 2 Cluster ถึงจะปลุก AI ──
        if (!testMode && activeClusters.size < 2) {
            console.log(`💤 ข้ามการวิเคราะห์รอบนี้ — ไม่ผ่านเงื่อนไขขั้นต่ำ (ต้องการอย่างน้อย 2 Cluster):`);
            console.log(`   📊 Momentum: ${activeClusters.has('Momentum') ? '✅' : '❌'} (RSI=${m15Data.rsi}, MACD=${m15Data.macd?.state || 'N/A'})`);
            console.log(`   📐 ValueZone: ${activeClusters.has('ValueZone') ? '✅' : '❌'} (Fibo/Round Number)`);
            console.log(`   🕯️ Structure: ${activeClusters.has('Structure') ? '✅' : '❌'} (Pattern=${m15Data.candlestick_pattern}, ${m15Data.breakout})`);
            botState.isRunning = false;
            return;
        }

        if (testMode) {
            console.log('🛠️ [Test Mode] ข้ามการเช็ค Scout Logic และเรียก AI วิเคราะห์โดยตรง...');
        } else {
            console.log(`🔔 ผ่าน ${activeClusters.size} Cluster [${[...activeClusters].join(' + ')}] — พบ ${triggerReasons.length} สัญญาณ:`);
            triggerReasons.forEach(r => console.log(`   → ${r}`));
        }

        // 3. สร้าง System Instruction
        const systemInstruction = `คุณคือ Quant Analyst วิเคราะห์ XAUUSD
บทบาท: ตัดสินใจ BUY / SELL / WAIT เท่านั้น (SL/TP ระบบคำนวณเอง)
กฎเหล็ก (ลำดับความสำคัญ):
1. Default = WAIT เสมอเมื่อไม่มั่นใจ หรือเทรนด์สับสน
2. ตามเทรนด์เป็นหลัก: BUY เมื่อ H1 uptrend + M15 HH/HL | SELL เมื่อ H1 downtrend + M15 LH/LL → confidence ได้ถึง HIGH
3. สวนเทรนด์ได้เฉพาะเมื่อมี Structure reversal ชัดเจน (เช่น Engulfing/Pin Bar ที่แนวรับ/ต้าน Fibo สำคัญ) → confidence สูงสุดแค่ MEDIUM เท่านั้น
4. RSI oversold ใน downtrend ที่ไม่มี reversal pattern = falling knife → WAIT
5. ADX < 20 → ตลาด Sideway ไร้ทิศทางชัดเจน → WAIT
6. สัญญาณขัดกัน → WAIT ทันที
ตอบ: <think>...</think> แล้ว JSON:
{"reasoning":"1 บรรทัด","action":"BUY|SELL|WAIT","confidence":"HIGH|MEDIUM|LOW"}`;

        // 4. ประกอบ Prompt (แบบเล่าเรื่อง + Chain of Thought + Context Memory)
        const h1Trend = h1Data.ema_fast > h1Data.ema_slow ? "ขาขึ้น" : "ขาลง";
        const trendAligned = 
            (h1Trend === 'ขาขึ้น' && m15Data.market_structure.includes('ขาขึ้น')) ||
            (h1Trend === 'ขาลง' && m15Data.market_structure.includes('ขาลง'));

        // สร้าง Context Memory จากรอบก่อน (ถ้ามี)
        let contextMemory = '';
        if (botState.lastAnalysis) {
            const la = botState.lastAnalysis;
            const priceChange = (m15Data.price - (la.price || m15Data.price)).toFixed(2);
            const direction = priceChange > 0 ? '📈 ขึ้น' : priceChange < 0 ? '📉 ลง' : '➡️ เท่าเดิม';
            
            // เช็คว่าสถานการณ์เปลี่ยนไปเยอะไหม (ถ้าเปลี่ยนเกิน 1 ATR หรือ Structure เปลี่ยน ให้ลืมความจำเดิม)
            if (Math.abs(priceChange) > m15Data.atr || (la.market_structure && la.market_structure !== m15Data.market_structure)) {
                contextMemory = `\n            - ⚠️ โครงสร้างหรือราคามีการเปลี่ยนแปลงอย่างมีนัยสำคัญจากรอบก่อน ให้เริ่มคิดใหม่ทั้งหมด ไม่ต้องอิงการตัดสินใจเดิม`;
            } else {
                contextMemory = `\n            📋 บริบทย้อนหลัง (Memory):
            - รอบก่อน AI ตัดสินใจ: ${la.decision || la.action || 'N/A'} (Confidence: ${la.confidence || 'N/A'}) เพราะ "${la.reasoning || 'ไม่มีข้อมูล'}"
            - ราคาตอนนั้น: $${la.price || 'N/A'} → ตอนนี้: $${m15Data.price} (${direction} $${Math.abs(priceChange)})
            - ⚠️ ถ้าสถานการณ์ไม่เปลี่ยนแปลง ให้ยืนยันการตัดสินใจเดิม อย่าเปลี่ยนใจไปมา ยกเว้นมีสัญญาณขัดแย้งชัดเจนขึ้น`;
            }
        }

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
            - Alignment H1↔M15: ${trendAligned ? '✅ สอดคล้อง' : '❌ ขัดกัน → ห้ามเทรดสวนเทรนด์ (WAIT)'}
            - ภาพย่อย (M15): ราคาล่าสุด $${m15Data.price} สถานะคือ ${m15Data.breakout}
            - 24H Range: High $${m15Data.recent_high} / Low $${m15Data.recent_low}
            - ราคาปัจจุบันอยู่ที่ ${((m15Data.price - m15Data.recent_low) / (m15Data.recent_high - m15Data.recent_low) * 100).toFixed(0)}% ของกรอบ 24 ชั่วโมง
            - ตัวเลขจิตวิทยา: ${m15Data.round_number}
            - รูปแบบกราฟ: เกิด ${m15Data.candlestick_pattern}
            - โมเมนตัม (RSI): RSI = ${m15Data.rsi}, ความผันผวน ATR = ${m15Data.atr}
            - โมเมนตัม (MACD): Line = ${m15Data.macd?.macd}, Signal = ${m15Data.macd?.signal}, Hist = ${m15Data.macd?.hist} (${m15Data.macd?.state})
            - โซนเฝ้าระวัง: แนวรับ/ต้าน Fibo (รอบ 24 ชม.) อยู่ที่ $${m15Data.fibo?.level_38_2}, $${m15Data.fibo?.level_50_0} และ $${m15Data.fibo?.level_61_8}
            - สถานการณ์ภายนอก: อยู่ในช่วง ${session} และ ${newsSummary.includes('ไม่มีข่าว') ? 'ไม่มีข่าวรุนแรง' : 'มีข่าวแดงต้องระวัง'} ${contextMemory}
            
            🚨 เหตุผลที่ระบบปลุกคุณขึ้นมาวิเคราะห์ (ผ่าน ${activeClusters.size} Cluster: ${[...activeClusters].join(', ')}):
            ${triggerReasons.length > 0 ? triggerReasons.map((r, i) => `${i+1}. ${r}`).join('\n            ') : '1. [Test Mode] ให้วิเคราะห์สภาวะตลาดปัจจุบัน'}
            
            คำสั่งบังคับ (ให้ออกแบบการตอบเป็น 2 ส่วนดังนี้):

            ส่วนที่ 1: กระบวนการคิด (ห่อหุ้มด้วยแท็ก <think> และ </think>)
            <think>
            อธิบายเหตุผลการตัดสินใจของคุณ (ความยาวไม่เกิน 6 บรรทัด)
            - ถ้า ADX < 20 หรือ Session เสี่ยง Sideway หรือ สัญญาณขัดแย้ง ให้ WAIT เป็นหลัก
            - อย่าดูจำนวนสัญญาณที่เยอะ เพราะอินดิเคเตอร์บางตัวมาจากสูตรคณิตศาสตร์เดียวกัน
            - วิเคราะห์เป็น Cluster: ${guides.join(' | ')}
            - สรุป: เป้าหมายคือคุณภาพสัญญาณ ไม่ใช่จำนวนสัญญาณ ถ้าไม่แน่ใจให้ตอบ WAIT ทันที
            </think>

            ส่วนที่ 2: บทสรุป (ตอบเป็น JSON Format เท่านั้น ห้ามพิมพ์ข้อความอื่นต่อท้าย)
            ระบบบอทจะเป็นคนคำนวณ SL/TP ทางคณิตศาสตร์เอง คุณมีหน้าที่แค่วิเคราะห์และบอกทิศทางเท่านั้น!
            {
              "reasoning": "เหตุผลสั้นๆ 1 บรรทัด",
              "action": "BUY หรือ SELL หรือ WAIT",
              "confidence": "HIGH หรือ MEDIUM หรือ LOW"
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
        let finalAction = parsedData.action ? parsedData.action.toUpperCase() : 'WAIT';
        let finalReasoning = parsedData.reasoning;
        const confidence = parsedData.confidence ? parsedData.confidence.toUpperCase() : 'MEDIUM';

        // Filter: ถ้าค่าความมั่นใจต่ำ (LOW) ให้บังคับ WAIT ทันที ป้องกันเดาเทรด
        if (finalAction !== 'WAIT' && confidence === 'LOW') {
            console.log(`⚠️ AI แนะนำ ${finalAction} แต่ให้ Confidence: LOW → บังคับ WAIT ทันที`);
            finalAction = 'WAIT';
            finalReasoning = `(Force WAIT) สัญญาณเดิมคือ ${parsedData.action} แต่ค่าความมั่นใจต่ำเกินไป (${parsedData.reasoning})`;
        }

        if (finalAction === 'WAIT' || !['BUY', 'SELL'].includes(finalAction)) {
            botState.lastAnalysis = {
                ts: Date.now(),
                price: m15Data.price,
                rsi: m15Data.rsi,
                trend: h1Trend,
                adx: h1Data.adx,
                session,
                market_structure: m15Data.market_structure,
                decision: 'WAIT',
                confidence: confidence,
                hasNews: !newsSummary.includes('ไม่มีข่าว'),
                triggers: triggerReasons,
                reasoning: finalReasoning
            };
            console.log(`✋ AI แนะนำให้ WAIT: ${finalReasoning}`);
            botState.isRunning = false;
            return;
        }

        parsedData.action = finalAction;
        parsedData.reasoning = finalReasoning;

        // 8. คำนวณ Risk Management (Structure-Aware SL/TP/BE)
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

        // --- Structure-Aware TP ---
        // รวบรวม "กำแพง" ทุกอันที่มีอยู่ (แนวรับ/ต้าน) จากข้อมูลที่คำนวณไว้แล้ว
        const walls = [];
        
        // 1. Fibonacci Levels
        if (m15Data.fibo) {
            if (m15Data.fibo.level_38_2) walls.push({ price: m15Data.fibo.level_38_2, label: 'Fibo 38.2%' });
            if (m15Data.fibo.level_50_0) walls.push({ price: m15Data.fibo.level_50_0, label: 'Fibo 50%' });
            if (m15Data.fibo.level_61_8) walls.push({ price: m15Data.fibo.level_61_8, label: 'Fibo 61.8%' });
        }
        
        // 2. 24H High / Low (แนวรับ/ต้านของวัน)
        if (m15Data.recent_high) walls.push({ price: m15Data.recent_high, label: '24H High' });
        if (m15Data.recent_low) walls.push({ price: m15Data.recent_low, label: '24H Low' });
        
        // 3. Round Numbers (ตัวเลขจิตวิทยาทุก $50 และ $10)
        const basePrice = entryPrice;
        for (let rn = Math.floor(basePrice / 50) * 50 - 50; rn <= Math.ceil(basePrice / 50) * 50 + 50; rn += 50) {
            if (rn > 0) walls.push({ price: rn, label: `Round $${rn}` });
        }
        for (let rn = Math.floor(basePrice / 10) * 10 - 20; rn <= Math.ceil(basePrice / 10) * 10 + 20; rn += 10) {
            if (rn > 0 && rn % 50 !== 0) walls.push({ price: rn, label: `Minor $${rn}` });
        }

        const naiveTpDistance = slDistance * 1.5; // R:R เริ่มต้น 1:1.5
        let tpAdjustReason = '';

        if (parsedData.action === 'BUY') {
            slPrice = entryPrice - slDistance;
            tpPrice = entryPrice + naiveTpDistance;
            bePrice = entryPrice + spreadBuffer + (currentAtr * 1.2);
            
            // หากำแพง (แนวต้าน) ที่อยู่ระหว่าง Entry กับ TP
            const resistanceWalls = walls
                .filter(w => w.price > entryPrice + (slDistance * 0.5) && w.price < tpPrice)
                .sort((a, b) => a.price - b.price); // เรียงจากใกล้สุดก่อน
            
            if (resistanceWalls.length > 0) {
                const nearestWall = resistanceWalls[0];
                const adjustedTp = nearestWall.price - 0.50; // วาง TP ก่อนกำแพง $0.50
                const adjustedRR = (adjustedTp - entryPrice) / slDistance;
                
                if (adjustedRR >= 1.0) {
                    tpPrice = adjustedTp;
                    tpAdjustReason = `⚠️ TP ถูกดึงกลับจาก R:R 1:1.5 → 1:${adjustedRR.toFixed(2)} เพราะเจอ ${nearestWall.label} ที่ $${nearestWall.price.toFixed(2)} ขวาง`;
                } else {
                    // R:R ต่ำกว่า 1:1 ไม่คุ้มเสี่ยง ข้ามไม้นี้
                    console.log(`🚫 [Structure Guard] TP ชนกำแพง ${nearestWall.label} ที่ $${nearestWall.price.toFixed(2)} ทำให้ R:R เหลือแค่ 1:${adjustedRR.toFixed(2)} — ข้ามไม้นี้`);
                    botState.lastAnalysis = {
                        ts: Date.now(),
                        price: m15Data.price,
                        rsi: m15Data.rsi,
                        trend: h1Trend,
                        adx: h1Data.adx,
                        session,
                        market_structure: m15Data.market_structure,
                        decision: 'WAIT',
                        confidence: 'LOW',
                        hasNews: !newsSummary.includes('ไม่มีข่าว'),
                        triggers: triggerReasons,
                        reasoning: `TP ชนแนวต้าน ${nearestWall.label} ที่ $${nearestWall.price.toFixed(2)} ทำให้ R:R ต่ำกว่า 1:1 ไม่คุ้มเสี่ยง`
                    };
                    botState.isRunning = false;
                    return;
                }
            }
        } else if (parsedData.action === 'SELL') {
            slPrice = entryPrice + slDistance;
            tpPrice = entryPrice - naiveTpDistance;
            bePrice = entryPrice - spreadBuffer - (currentAtr * 1.2);
            
            // หากำแพง (แนวรับ) ที่อยู่ระหว่าง Entry กับ TP
            const supportWalls = walls
                .filter(w => w.price < entryPrice - (slDistance * 0.5) && w.price > tpPrice)
                .sort((a, b) => b.price - a.price); // เรียงจากใกล้สุดก่อน
            
            if (supportWalls.length > 0) {
                const nearestWall = supportWalls[0];
                const adjustedTp = nearestWall.price + 0.50; // วาง TP หลังกำแพง $0.50
                const adjustedRR = (entryPrice - adjustedTp) / slDistance;
                
                if (adjustedRR >= 1.0) {
                    tpPrice = adjustedTp;
                    tpAdjustReason = `⚠️ TP ถูกดึงกลับจาก R:R 1:1.5 → 1:${adjustedRR.toFixed(2)} เพราะเจอ ${nearestWall.label} ที่ $${nearestWall.price.toFixed(2)} ขวาง`;
                } else {
                    console.log(`🚫 [Structure Guard] TP ชนกำแพง ${nearestWall.label} ที่ $${nearestWall.price.toFixed(2)} ทำให้ R:R เหลือแค่ 1:${adjustedRR.toFixed(2)} — ข้ามไม้นี้`);
                    botState.lastAnalysis = {
                        ts: Date.now(),
                        price: m15Data.price,
                        rsi: m15Data.rsi,
                        trend: h1Trend,
                        adx: h1Data.adx,
                        session,
                        market_structure: m15Data.market_structure,
                        decision: 'WAIT',
                        confidence: 'LOW',
                        hasNews: !newsSummary.includes('ไม่มีข่าว'),
                        triggers: triggerReasons,
                        reasoning: `TP ชนแนวรับ ${nearestWall.label} ที่ $${nearestWall.price.toFixed(2)} ทำให้ R:R ต่ำกว่า 1:1 ไม่คุ้มเสี่ยง`
                    };
                    botState.isRunning = false;
                    return;
                }
            }
        }

        // Log TP adjustment ถ้ามี
        if (tpAdjustReason) console.log(`📐 [Structure-Aware TP] ${tpAdjustReason}`);

        // Format ทศนิยม 2 ตำแหน่ง
        const formatPrice = (p) => p.toFixed(2);

        // 9. จัดหน้าตาข้อความส่งเข้า Telegram
        const actualRR = parsedData.action === 'BUY' 
            ? ((tpPrice - entryPrice) / slDistance).toFixed(2)
            : ((entryPrice - tpPrice) / slDistance).toFixed(2);

        let messageToTelegram = `
🎯 <b>XAU_Sentinel AI Signal</b> 🎯
🌍 <b>แนวโน้ม:</b> ${m15Data.market_structure}
💡 <b>Action:</b> <b>${parsedData.action}</b>
📍 <b>Entry:</b> ${formatPrice(entryPrice)}
🛑 <b>SL:</b> ${formatPrice(slPrice)} (ATRx1.5)
💰 <b>TP:</b> ${formatPrice(tpPrice)} (R:R 1:${actualRR})
🛡️ <b>BE:</b> ${formatPrice(bePrice)} (หัก Spread แล้ว)
${tpAdjustReason ? `\n📐 <b>Structure Guard:</b> <i>${tpAdjustReason}</i>` : ''}
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
            market_structure: m15Data.market_structure,
            decision: parsedData.action,
            confidence: parsedData.confidence ? parsedData.confidence.toUpperCase() : 'MEDIUM',
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
