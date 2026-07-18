const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/**
 * ส่งข้อความเข้า Telegram
 * @param {string} text - ข้อความที่ต้องการส่ง (รองรับ HTML)
 * @returns {Promise<boolean>} สถานะการส่ง (สำเร็จ/ล้มเหลว)
 */
export async function sendTelegramMessage(text, retryCount = 0) {
    const MAX_RETRIES = 3;
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('Telegram credentials not configured, skipping Telegram notification.');
        return false;
    }

    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    
    try {
        console.log('Sending message to Telegram...');
        const response = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: 'HTML'
            })
        });

        if (response.ok) {
            console.log('Message sent to Telegram successfully.');
            return true;
        }

        // จัดการ Rate Limit (429) โดยจำกัดจำนวนครั้ง
        if (response.status === 429 && retryCount < MAX_RETRIES) {
            const retryData = await response.json().catch(() => ({}));
            const retryAfter = retryData.parameters?.retry_after || 3;
            console.warn(`Telegram rate limited, retrying after ${retryAfter}s (attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            return sendTelegramMessage(text, retryCount + 1);
        }

        // ถ้า HTML parsing ล้มเหลว (400) → ส่งแบบ Plain text แทน (ตัด HTML ทิ้ง)
        if (response.status === 400) {
            console.warn("Telegram HTML parsing failed (400). Retrying as plain text...");
            const plainText = text.replace(/<\/?[^>]+(>|$)/g, ''); // ตัด HTML tag ทั้งหมดออก
            const fallback = await fetch(telegramUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: plainText
                })
            });
            if (fallback.ok) {
                console.log('Message sent to Telegram successfully (Plain text).');
                return true;
            }
            throw new Error(`Telegram fallback failed: ${fallback.status}`);
        }

        if (response.status === 401) {
            console.error("Telegram Error: Unauthorized. Check your BOT_TOKEN.");
        }
        throw new Error(`Telegram API Error: ${response.status}`);

    } catch (error) {
        console.error("Error sending to Telegram:", error.message || error);
        throw error;
    }
}
