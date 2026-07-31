import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini with API key
const genAI = process.env.GEMINI_API_KEY 
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;

// Gemini Rate Guard: นับจำนวนครั้งที่ใช้ต่อวัน (Free Tier จำกัด ~20 RPD)
let geminiDailyCount = 0;
let geminiCountDate = new Date().toDateString();
const GEMINI_DAILY_LIMIT = 10; // เหลือ 10 ครั้งสำรองไว้ ไม่ใช้หมด 20

/**
 * วิเคราะห์ข้อมูลตลาดด้วย Gemini AI
 * @param {string} prompt - ข้อความ Prompt ที่ต้องการให้ AI วิเคราะห์
 * @param {string} systemInstruction - คำสั่งตั้งต้นของ AI (System Prompt)
 * @returns {Promise<string>} ข้อความที่ AI วิเคราะห์เสร็จแล้ว
 */
export async function analyzeTrading(prompt, systemInstruction = "คุณคือ AI ผู้เชี่ยวชาญด้านการเทรดทองคำ (XAUUSD) ให้คำแนะนำที่กระชับ แม่นยำ และจัดรูปแบบข้อความให้อ่านง่ายสำหรับ Telegram ห้ามตอบเรื่องอื่นที่ไม่เกี่ยวกับการเทรด") {
    if (!genAI) {
        throw new Error("GEMINI_API_KEY is not configured.");
    }

    // Rate Guard: รีเซ็ตตัวนับทุกวัน
    const today = new Date().toDateString();
    if (today !== geminiCountDate) {
        geminiDailyCount = 0;
        geminiCountDate = today;
    }

    // เช็คว่าเกินโควต้าวันนี้หรือยัง
    if (geminiDailyCount >= GEMINI_DAILY_LIMIT) {
        throw new Error(`Gemini Rate Guard: ใช้ครบ ${GEMINI_DAILY_LIMIT} ครั้งแล้ววันนี้ เหลือโควต้าไว้สำรอง`);
    }

    const model = genAI.getGenerativeModel({ 
        model: "gemini-3.5-flash",
        systemInstruction: systemInstruction,
        generationConfig: {
            temperature: 0.15, // สม่ำเสมอ เหมือน Groq
        }
    });

    console.log(`Requesting analysis from Gemini (Fallback)... [${geminiDailyCount + 1}/${GEMINI_DAILY_LIMIT} วันนี้]`);
    const result = await model.generateContent(prompt);
    
    // เช็คกรณีโดน Safety Block
    if (!result.response.candidates || result.response.candidates.length === 0) {
        const blockReason = result.response.promptFeedback?.blockReason;
        throw new Error(`Gemini returned no response${blockReason ? ` (blocked: ${blockReason})` : ''}`);
    }

    const text = result.response.text();
    
    // เช็คกรณีส่งข้อความว่างเปล่ากลับมา
    if (!text || text.trim().length === 0) {
        throw new Error('Gemini returned empty text');
    }
    
    geminiDailyCount++; // นับเฉพาะเมื่อสำเร็จ
    console.log('Analysis received from Gemini.');
    
    return text;
}
