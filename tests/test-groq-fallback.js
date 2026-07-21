import { analyzeTradingWithGroq } from '../lib/groq.js';
import { analyzeTrading } from '../lib/gemini.js';
import { fetchWithRetry } from '../lib/utils.js';

async function testFallback() {
    console.log("=== Testing AI Fallback System ===");
    const dummyPrompt = "ราคาทองคำ H1 ขาขึ้น, M15 RSI 70 ให้ทำอย่างไร?";
    const systemInstruction = "ตอบสั้นๆ ไม่เกิน 2 บรรทัด";

    let aiResponse;
    let usedFallback = false;
    
    // จำลองสถานการณ์ Gemini ล่ม (โดยส่ง Prompt ปลอมที่อาจจะโดนแบน หรือแค่จำลอง throw)
    console.log("1. Forcing Gemini to fail...");
    try {
        // แกล้งจำลองว่า Gemini ล่ม
        throw new Error("503 Service Unavailable (Simulated)");
    } catch (geminiErr) {
        console.warn(`[Fallback] Gemini ล่มหรือติดลิมิต (${geminiErr.message})... กำลังสลับไปใช้ Groq AI สำรอง!`);
        try {
            aiResponse = await fetchWithRetry(() => analyzeTradingWithGroq(dummyPrompt, systemInstruction), 3, 1000);
            usedFallback = true;
        } catch (groqErr) {
            console.error(`[Fatal] ทั้ง Gemini และ Groq ล่มทั้งหมด: ${groqErr.message}`);
            return;
        }
    }

    if (usedFallback) {
        aiResponse += '\n\n*(วิเคราะห์โดย ⚡ Groq Fallback AI)*';
    }

    console.log("\n=== 🎯 FINAL RESPONSE ===");
    console.log(aiResponse);
    console.log("==========================\n");
}

testFallback();
