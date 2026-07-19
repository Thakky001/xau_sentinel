import { runScoutBot } from '../lib/bot.js';

async function runTests() {
    console.log("=== 🧪 เริ่มการทดสอบ Hybrid Scout Bot ===");
    
    console.log("\n▶️ [Test 1] รันการวิเคราะห์รอบแรก (แบบ Force บังคับทะลุวันหยุด/RSI)");
    await runScoutBot(true);

    console.log("\n▶️ [Test 2] รันรอบสองทันที (แบบปกติ)");
    console.log("ถึงแม้วันนี้จะเป็นวันหยุด แต่เพราะ Test 1 เพิ่งส่งข้อความไป... Test 2 ต้องโดนบล็อคโดย Cooldown!");
    await runScoutBot(false);

    console.log("\n=== 🏁 จบการทดสอบ ===");
    process.exit(0);
}

runTests();
