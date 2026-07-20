// ต้อง import logger ก่อนทุกอย่าง เพื่อให้ intercept console ได้ทันที
import './lib/logger.js';

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { runScoutBot, getBotState } from './lib/bot.js';
import { getLogs } from './lib/logger.js';

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
app.listen(PORT, () => {
    console.log(`🚀 XAU Sentinel Server is running on port ${PORT}`);

    // รันครั้งแรกทันที
    runScoutBot();

    // Loop ทุก 15 นาที
    const INTERVAL_MS = 15 * 60 * 1000;
    setInterval(() => {
        runScoutBot();
    }, INTERVAL_MS);
});
