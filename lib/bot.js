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
        const systemInstruction = `คุณคือ AI นักวิเคราะห์ทางเทคนิคตลาดทองคำ (XAUUSD) ระดับ Hedge Fund 
คุณจะได้รับข้อมูล MTFA (H1 + M15), Price Action (Swing High/Low 20 แท่งล่าสุด), และช่วงเวลาตลาดปัจจุบัน
วิเคราะห์ข้อมูลทั้งหมดนี้เพื่อหาแผนการเทรดที่ได้เปรียบที่สุด ตอบเป็นภาษาไทย ใช้ HTML format (<b>, <i>, <pre>) ห้ามใช้ Markdown ** เด็ดขาด`;

        // 4. ประกอบ Prompt ขั้นเทพ
        const prompt = `
            ข้อมูลตลาดทองคำ XAUUSD (ดึงจาก Deriv API — ข้อมูลจริง):

            ⏱️ ช่วงเวลาตลาดปัจจุบัน (Market Session): ${session}
            ${newsSummary}
            
            🌍 ภาพใหญ่ (Timeframe H1) - ใช้วิเคราะห์เทรนด์หลักของวัน:
            - ปิดล่าสุด: $${h1Data.price}
            - RSI (14): ${h1Data.rsi}
            - EMA: Fast (9) = $${h1Data.ema_fast} | Slow (21) = $${h1Data.ema_slow}
            - MACD: Line = ${h1Data.macd.line} | Signal = ${h1Data.macd.signal} | Histogram = ${h1Data.macd.hist}

            🔍 ภาพย่อย (Timeframe M15) - ใช้หาจุดเข้าที่คมกริบ:
            - ราคาปัจจุบัน: Open $${m15Data.open} | High $${m15Data.high} | Low $${m15Data.low} | Close $${m15Data.price}
            - แท่งเทียนก่อนหน้า: High $${m15Data.prev_high} | Low $${m15Data.prev_low} | Close $${m15Data.prev_close}
            - RSI (14): ${m15Data.rsi}
            - EMA: Fast (9) = $${m15Data.ema_fast} | Slow (21) = $${m15Data.ema_slow}
            - MACD: Line = ${m15Data.macd.line} | Signal = ${m15Data.macd.signal} | Histogram = ${m15Data.macd.hist}
            - ATR (14) (ความผันผวน): ${m15Data.atr}

            ⛰️ Price Action (M15 Swing ย้อนหลัง 20 แท่ง):
            - Highest High (แนวต้านแข็งระยะสั้น): $${m15Data.recent_high}
            - Lowest Low (แนวรับแข็งระยะสั้น): $${m15Data.recent_low}
            - รูปแบบแท่งเทียนล่าสุด: ${m15Data.candlestick_pattern}
            - โซนย่อตัว Fibonacci (Golden Ratio): ระดับ 50% = $${m15Data.fibo.level_50_0} | ระดับ 61.8% = $${m15Data.fibo.level_61_8}

            คำสั่งวิเคราะห์ (ให้ออกแบบรูปแบบการตอบให้อ่านง่ายที่สุด สั้นที่สุด):
            1. 🌍 แนวโน้มตลาด: (บอกแค่สั้นๆ เช่น ขาขึ้น / ขาลง / ไซด์เวย์)
            2. 🎯 โซนแนวรับ: $xxxx | แนวต้าน: $xxxx
            3. 💡 แผนการเทรด (เน้นตัวเลข ห้ามอธิบายเหตุผลยาวๆ):
               - ทิศทาง: BUY / SELL / WAIT (สำคัญ: หากมีข่าวกล่องแดงในอีก 1-2 ชั่วโมงข้างหน้า ให้พิจารณาสั่ง WAIT เพื่อหลบข่าวทันที)
               - 📍 Entry: $xxxx.xx (แนะนำให้ประเมินจุดเข้าใกล้โซน Fibo 50%-61.8% หรือจุดที่มี Price Action กลับตัว)
               - 🛑 SL: $xxxx.xx 
               - 🎯 TP: $xxxx.xx (หรือ TP1, TP2)
            4. 🛡️ เลื่อน SL บังทุนเมื่อ: $xxxx.xx | ปิดกำไรครึ่งหนึ่งเมื่อ: $xxxx.xx
            
            ข้อกำหนดบังคับขั้นเด็ดขาด: 
            - ตอบให้สั้นที่สุดเหมือน "ป้ายบอกทาง" ห้ามเขียนเรียงความหรือบรรยายน้ำท่วมทุ่ง
            - ตัดเหตุผลยืดยาวทิ้งไปให้หมด เน้นให้คนอ่านกวาดตา 2 วินาทีแล้วไปตั้งออเดอร์ตามได้เลย
            - ตอบเป็นภาษาไทย
            - บังคับใช้แท็ก HTML <b> ครอบตัวเลขราคาให้เด่นชัด (ห้ามใช้ **)
        `;

        // 5. ให้ Gemini วิเคราะห์
        const aiResponse = await fetchWithRetry(() => analyzeTrading(prompt, systemInstruction));

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
