import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini with API key
const genAI = process.env.GEMINI_API_KEY 
    ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
    : null;

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

    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash", // แก้เป็น 1.5-flash รุ่นจริง โควต้า 1,500 ครั้ง/วัน
        systemInstruction: systemInstruction
    });

    console.log('Requesting analysis from Gemini...');
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
    
    console.log('Analysis received from Gemini.');
    
    return text;
}
