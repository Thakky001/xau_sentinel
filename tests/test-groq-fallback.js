import { analyzeTradingWithGroq } from '../lib/groq.js';
import { analyzeTrading } from '../lib/gemini.js';
import { fetchWithRetry } from '../lib/utils.js';

async function testFallback() {
    console.log("=== Testing AI Fallback System ===");
    const dummyPrompt = "ราคาทองคำ H1 ขาขึ้น, M15 RSI 70 ให้ทำอย่างไร?";
    const systemInstruction = "ตอบสั้นๆ ไม่เกิน 2 บรรทัด";

    let aiResponse;
    let usedFallback = false;
    
    // จำลองสถานการณ์ Groq ล่ม 
    console.log("1. Forcing Groq to fail...");
    try {
        // แกล้งจำลองว่า Groq ล่ม
        throw new Error("503 Service Unavailable (Simulated)");
    } catch (groqErr) {
        console.warn(`[Fallback] Groq ล่มหรือติดลิมิต (${groqErr.message})... กำลังสลับไปใช้ Gemini AI สำรอง!`);
        try {
            aiResponse = await fetchWithRetry(() => analyzeTrading(dummyPrompt, systemInstruction), 3, 1000);
            usedFallback = true;
        } catch (geminiErr) {
            console.error(`[Fatal] ทั้ง Groq และ Gemini ล่มทั้งหมด: ${geminiErr.message}`);
            return;
        }
    }

    if (usedFallback) {
        aiResponse += '\n\n*(วิเคราะห์โดย 🧠 Gemini Fallback AI)*';
    }

    console.log("\n=== 🎯 FINAL RESPONSE ===");
    console.log(aiResponse);
    console.log("==========================\n");
}

testFallback();
