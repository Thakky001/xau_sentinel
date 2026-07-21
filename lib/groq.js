import Groq from 'groq-sdk';

// Initialize Groq with API key
const groq = process.env.GROQ_API_KEY 
    ? new Groq({ apiKey: process.env.GROQ_API_KEY })
    : null;

/**
 * วิเคราะห์ข้อมูลตลาดด้วย Groq AI (Llama 3)
 * @param {string} prompt - ข้อความ Prompt ที่ต้องการให้ AI วิเคราะห์
 * @param {string} systemInstruction - คำสั่งตั้งต้นของ AI (System Prompt)
 * @returns {Promise<string>} ข้อความที่ AI วิเคราะห์เสร็จแล้ว
 */
export async function analyzeTradingWithGroq(prompt, systemInstruction = "คุณคือ AI ผู้เชี่ยวชาญด้านการเทรดทองคำ (XAUUSD) ให้คำแนะนำที่กระชับ แม่นยำ และจัดรูปแบบข้อความให้อ่านง่ายสำหรับ Telegram ห้ามตอบเรื่องอื่นที่ไม่เกี่ยวกับการเทรด") {
    if (!groq) {
        throw new Error("GROQ_API_KEY is not configured.");
    }

    console.log('Requesting analysis from Groq (Fallback)...');
    
    const response = await groq.chat.completions.create({
        messages: [
            {
                role: "system",
                content: systemInstruction
            },
            {
                role: "user",
                content: prompt
            }
        ],
        model: "llama-3.3-70b-versatile", // ใช้รุ่นล่าสุดเพื่อความฉลาดเทียบเท่าหรือมากกว่า Gemini
        temperature: 0.5,
        max_tokens: 2048,
        top_p: 1,
    });

    const text = response.choices[0]?.message?.content;
    
    // เช็คกรณีส่งข้อความว่างเปล่ากลับมา
    if (!text || text.trim().length === 0) {
        throw new Error('Groq returned empty text');
    }
    
    console.log('Analysis received from Groq.');
    
    return text;
}
