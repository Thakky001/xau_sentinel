import express from 'express';
import { runScoutBot } from './lib/bot.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ป้องกันปัญหาแอพค้างเวลามีการยิง Request เข้ามา
app.use(express.json());

// Endpoint สำหรับให้ UptimeRobot ยิงเข้ามาเพื่อกันเซิร์ฟเวอร์หลับ (Sleep)
app.get('/ping', (req, res) => {
    res.status(200).send('Pong! XAU Sentinel is awake. 🤖');
});

// เริ่มเซิร์ฟเวอร์
app.listen(PORT, () => {
    console.log(`🚀 XAU Sentinel Server is running on port ${PORT}`);
    
    // สั่งให้รันครั้งแรกทันทีที่เปิดเซิร์ฟเวอร์
    runScoutBot();

    // ตั้งเวลา (Loop) ให้รันระบบวิเคราะห์ทุกๆ 15 นาที
    // 15 นาที = 15 * 60 * 1000 = 900,000 มิลลิวินาที
    const INTERVAL_MS = 15 * 60 * 1000;
    
    setInterval(() => {
        runScoutBot();
    }, INTERVAL_MS);
});
