export function sanitizeForTelegram(text) {
    // ตัดส่วน <think>...</think> ที่เป็น Chain of Thought ออกไป เพื่อไม่ให้รกแชท
    let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // แปลง markdown ** ที่หลุดมาให้เป็น <b> แทน เผื่อ AI ไม่ทำตามคำสั่ง
    clean = clean.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    // Telegram รองรับ tag จำกัด — ตัด tag ที่ไม่รู้จักทิ้งเผื่อ AI ใช้ผิด (เช่น <p>, <div>)
    // tag ที่รองรับ: b, i, u, s, code, pre, a
    clean = clean.replace(/<(?!\/?(b|i|u|s|code|pre|a)\b)[^>]*>/gi, '');
    return clean;
}

export function splitTelegramMessage(text, maxLength = 4096) {
    if (text.length <= maxLength) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }
        // ตัดที่ขึ้นบรรทัดใหม่ใกล้ maxLength ที่สุด กันตัดกลางคำ/กลาง HTML tag
        let cutAt = remaining.lastIndexOf('\n', maxLength);
        if (cutAt <= 0) cutAt = maxLength;
        chunks.push(remaining.slice(0, cutAt));
        remaining = remaining.slice(cutAt);
    }
    return chunks;
}

export function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function fetchWithRetry(fn, retries = 2, delayMs = 2000) {
    for (let i = 0; i <= retries; i++) {
        try {
            return await fn();
        } catch (err) {
            // ไม่ต้อง retry สำหรับ Error ที่ retry ไปก็ไม่ช่วย (เช่น ถูกบล็อก, Token ผิด, โดนแบน)
            const isNonRetryable = /blocked:|GEMINI_API_KEY|Unauthorized|401|403/i.test(err.message);
            if (isNonRetryable || i === retries) throw err;
            console.warn(`Retry ${i + 1}/${retries} after error: ${err.message}`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}
