import './lib/logger.js';

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { runScoutBot, getBotState, setNextRunAt } from './lib/bot.js';
import { getLogs } from './lib/logger.js';
import { initGoogleSheets } from './lib/sheets.js';
import { startTracker, getPortfolioState } from './lib/tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Serve static files จาก public/
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Endpoints ───────────────────────────────────────────

// Dashboard ดึงข้อมูล state + logs
app.get('/api/status', (req, res) => {
    res.json({
        ...getBotState(),
        portfolio: getPortfolioState(),
        logs: getLogs(),
    });
});

// UptimeRobot ping (กันเซิร์ฟเวอร์หลับ)
app.get('/ping', (req, res) => {
    res.status(200).send('Pong! XAU Sentinel is awake. 🤖');
});

// Dashboard (serve index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, async () => {
    console.log(`🚀 XAU Sentinel Server is running on port ${PORT}`);
    
    // 1. Initialize Google Sheets
    const sheetsReady = await initGoogleSheets();
    
    // 2. Start Tracker Bot (Circuit Breaker)
    if (sheetsReady) {
        startTracker();
    } else {
        console.warn("⚠️ ไม่สามารถเปิด Tracker Bot ได้เนื่องจาก Database ไม่พร้อม");
    }

    // 3. Start Scout Bot Scheduler
    scheduleBot();
});

// ─── M15 Clock-Snapped Scheduler ─────────────────────────────
// รันหลังแท่งเทียน M15 ปิด 5 วินาที (:00:05, :15:05, :30:05, :45:05)
// ทำให้ข้อมูลแท่งปิดสมบูรณ์ก่อนวิเคราะห์เสมอ
// และ Render restart กลางทางก็ไม่ทำให้ timing เพี้ยน

const INTERVAL_MS  = 15 * 60 * 1000; // 15 นาที
const CANDLE_DELAY =      5 * 1000;  // รอ 5 วิ หลังแท่งปิด

function msUntilNextM15() {
    const now  = Date.now();
    // หา timestamp ของ M15 slot ถัดไป (:00, :15, :30, :45)
    const next = Math.ceil(now / INTERVAL_MS) * INTERVAL_MS;
    // บวก delay 5 วิ เพื่อให้แท่งปิดสมบูรณ์
    return (next + CANDLE_DELAY) - now;
}

function scheduleBot() {
    const delay = msUntilNextM15();
    const runAt = new Date(Date.now() + delay);
    const hhmm  = runAt.toLocaleTimeString('th-TH', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Asia/Bangkok'
    });
    console.log(`🕐 Scheduler: จะรันครั้งถัดไปเวลา ${hhmm} (อีก ${Math.round(delay/1000)} วินาที)`);

    // อัปเดต nextRunAt ใน dashboard ทันที ไม่ต้องรอให้ bot รันก่อน
    setNextRunAt(Date.now() + delay);

    setTimeout(() => {
        runScoutBot();
        // หลังรันแล้ว วนซ้ำ — ครั้งต่อไปจะตรงกับ M15 ถัดไปเสมอ
        scheduleBot();
    }, delay);
}
