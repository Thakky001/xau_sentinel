/**
 * In-Memory Logger
 * Intercepts console.log/warn/error และเก็บลง ring buffer 200 บรรทัด
 * ไม่ต้องแก้ไฟล์อื่นเลย — import ไฟล์นี้ครั้งเดียวใน server.js ก็ทำงานทันที
 */

const MAX_LOGS = 200;
const logBuffer = [];

function addLog(level, args) {
    // แปลง args เป็น string สำหรับ display
    const message = args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');

    logBuffer.push({ ts: Date.now(), level, message });

    // Ring buffer: ลบอันเก่าสุดออกถ้าเกิน MAX_LOGS
    if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

// Override console เพื่อ intercept ทุก log โดยไม่แตะโค้ดอื่น
const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

console.log   = (...args) => { addLog('info',  args); _log(...args);   };
console.warn  = (...args) => { addLog('warn',  args); _warn(...args);  };
console.error = (...args) => { addLog('error', args); _error(...args); };

/**
 * คืน log ทั้งหมด (ใหม่สุดก่อน) สำหรับส่งออก API
 * @returns {Array<{ts: number, level: string, message: string}>}
 */
export function getLogs() {
    return [...logBuffer].reverse();
}
