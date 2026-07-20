import { fetchDerivCandles } from './deriv.js';
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

// ตัวแปรเก็บเวลาแจ้งเตือนล่าสุด (ป้องกันการส่งแจ้งเตือนซ้ำซาก)
let lastAlertTime = 0;
const COOLDOWN_MS = 1 * 60 * 60 * 1000; // ปรับลดเวลาพักเบรกเหลือ 1 ชั่วโมง (4 แท่ง M15)

export async function runScoutBot(testMode = false) {
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

        console.log('🤖 Scout Bot Waking up: Fetching H1 and M15 data from Deriv...');
        
        // 1. ดึงข้อมูล 2 Timeframes พร้อมกัน (H1 = 3600, M15 = 900)
        const [h1Data, m15Data] = await Promise.all([
            fetchWithRetry(() => fetchDerivCandles(3600, 100)), // H1
            fetchWithRetry(() => fetchDerivCandles(900, 100))   // M15
        ]);
        
        const session = getMarketSession();
        const newsSummary = await getUpcomingHighImpactNews();

        console.log(`✅ MTFA fetched. H1 Price: $${h1Data.price}, M15 Price: $${m15Data.price}, Session: ${session}`);
        console.log(`📰 News: ${newsSummary.replace(/\n/g, ' ')}`);
        console.log(`📊 M15 RSI: ${m15Data.rsi}`);

        // 2. Scout Logic (ตัวกรองความน่าสนใจ)
        // ตรวจสอบว่า RSI ของ M15 เข้าโซน Overbought (>65) หรือ Oversold (<35) หรือไม่
        const isM15Overbought = m15Data.rsi > 65;
        const isM15Oversold = m15Data.rsi < 35;

        if (!testMode && !isM15Overbought && !isM15Oversold) {
            console.log('💤 ตลาดอยู่ในสภาวะปกติ (M15 RSI อยู่ระหว่าง 35-65) ไม่ทำอะไรเพื่อประหยัดโควต้า AI');
            return;
        }

        if (testMode) {
            console.log('🛠️ [Test Mode] ข้ามการเช็ค RSI และเรียก AI วิเคราะห์โดยตรง...');
        } else {
            console.log('🚨 พบสัญญาณ M15 RSI เข้าเขตอันตราย! กำลังส่งให้ AI วิเคราะห์...');
        }

        // 3. สร้าง System Instruction
        const systemInstruction = `คุณคือ AI ผู้จัดการกองทุน (Fund Manager) วิเคราะห์ทองคำ (XAUUSD)
หน้าที่ของคุณคือรับข้อมูลตลาด และต้อง "คิดวิเคราะห์ทีละขั้นตอน (Chain of Thought)" ก่อนตัดสินใจ BUY, SELL หรือ WAIT
ตอบเป็นภาษาไทย ใช้ HTML format (<b>, <i>, <pre>) ห้ามใช้ Markdown ** เด็ดขาด`;

        // 4. ประกอบ Prompt ขั้นเทพ (แบบเล่าเรื่อง + Chain of Thought)
        const h1Trend = h1Data.ema_fast > h1Data.ema_slow ? "ขาขึ้น" : "ขาลง";
        const prompt = `
            สรุปสภาวะตลาดทองคำ ณ ปัจจุบัน:
            - ภาพใหญ่ (H1): เป็นเทรนด์${h1Trend} (EMA9=${h1Data.ema_fast}, EMA21=${h1Data.ema_slow}) ความแรงเทรนด์ ADX = ${h1Data.adx || 'N/A'}
            - ภาพย่อย (M15): ราคาล่าสุดอยู่ที่ $${m15Data.price} สถานะคือ ${m15Data.breakout}
            - รูปแบบกราฟ: เกิด ${m15Data.candlestick_pattern}
            - โมเมนตัม: RSI = ${m15Data.rsi}, ความผันผวน ATR = ${m15Data.atr}
            - โซนเฝ้าระวัง: แนวรับ/ต้าน Fibo อยู่ที่ $${m15Data.fibo?.level_50_0} ถึง $${m15Data.fibo?.level_61_8}
            - สถานการณ์ภายนอก: อยู่ในช่วง ${session} และ ${newsSummary.includes('ไม่มีข่าว') ? 'ไม่มีข่าวรุนแรง' : 'มีข่าวแดงต้องระวัง'}
            
            คำสั่งบังคับ (ให้ออกแบบการตอบเป็น 2 ส่วนดังนี้):

            ส่วนที่ 1: กระบวนการคิด (ห่อหุ้มด้วยแท็ก <think> และ </think>)
            <think>
            อธิบายตรรกะของคุณทีละขั้นตอน: 
            1. เทรนด์หลักและโมเมนตัมขัดแย้งกันหรือไม่?
            2. โครงสร้างราคายืนยันจุดเข้า (Fibo/Pin Bar) ชัดเจนแค่ไหน?
            3. ตลาดอยู่ในสภาวะที่มีข่าวหรือความผันผวนสูงจนควรหลีกเลี่ยง (WAIT) หรือไม่?
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
            console.log('✋ AI แนะนำให้ WAIT (รอดูท่าที) ระบบจะไม่ส่งแจ้งเตือนเข้า Telegram เพื่อลดความรำคาญ');
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
        
        // 8. เริ่มนับเวลา Cooldown ทันทีที่ส่งแผนเทรดสำเร็จ
        lastAlertTime = Date.now();
        console.log('✅ ส่งแผนเทรดสำเร็จ! (เริ่มนับ Cooldown 1 ชั่วโมง)');

    } catch (error) {
        console.error("❌ Error processing Scout bot:", error.message || error);
        try {
            const errorMsg = `⚠️ <b>Hybrid Bot Failed</b>\n<pre>${escapeHtml(String(error.message || error))}</pre>`;
            await sendTelegramMessage(errorMsg);
        } catch (notifyErr) {
            console.error("Failed to send error notification:", notifyErr.message || notifyErr);
        }
    }
}
