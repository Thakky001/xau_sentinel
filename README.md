# XAU Sentinel 🤖📈 (Hybrid 24/7 Edition)

ระบบ AI วิเคราะห์และแจ้งเตือนจุดเข้าเทรดทองคำ (XAUUSD) อัตโนมัติ โดยผสมผสาน Technical Analysis เข้ากับพลังการคิดของ **Gemini AI** ส่งสัญญาณตรงเข้า Telegram แบบ Real-time

โปรเจกต์นี้ออกแบบมาให้ทำงานแบบ **Server 24/7** บน **Render.com** พร้อมหน้าเว็บ Dashboard สำหรับสอดส่องการทำงานของบอท

---

## 🌟 ฟีเจอร์หลัก (Features)

1. **Active Tracker (ทหารพรานเฝ้ากราฟ):** 
   บอทไม่ได้ส่งกราฟให้ AI ดูมั่วซั่ว แต่จะดึงข้อมูลทุกๆ 15 นาที เพื่อตรวจสอบ 4 เงื่อนไขหลัก:
   - **RSI สุดโต่ง:** ทะลุโซน 35 (Oversold) หรือ 65 (Overbought)
   - **Fibo Test:** ราคาชนแนว Fibonacci สำคัญ (50% / 61.8%) พร้อมระบบ Dynamic Tolerance (ATR × 0.3)
   - **Price Action:** ตรวจจับแท่งเทียนกลับตัว เช่น Pin Bar, Engulfing
   - **Breakout:** ราคาทะลุกรอบสะสมพลัง (Swing High/Low)
   *หากตลาดวิ่งเอื่อยๆ บอทจะข้ามการวิเคราะห์เพื่อลดการเรียก AI โดยไม่จำเป็น*

2. **Smart Prompting & Confluence:**
   เมื่อพบสัญญาณน่าสนใจ บอทจะป้อน "กรอบแนวคิด (Analysis Guide)" ให้ AI พิจารณาตามสัญญาณที่เจอ พร้อมบังคับใช้กฎ **Confluence** (สัญญาณต้องสอดคล้องกันอย่างน้อย 2 ข้อ) หากขัดแย้งกัน (เช่น H1 เทรนด์ขึ้นแรง แต่ M15 เพิ่งเกิดแท่งเทียนลง) AI จะสั่ง **WAIT** ทันที เพื่อป้องกันการจับมีดตก

3. **Multi-Timeframe Analysis (MTFA):** 
   ดึงกราฟ H1 (ดูเทรนด์ใหญ่และพละกำลังผ่าน EMA + ADX) และ M15 (หาจุดเข้าที่เฉียบคมและแม่นยำ) ไปพร้อมกัน

4. **AI Fallback System (สมองกลสำรอง):**
   หากเซิร์ฟเวอร์ Google (Gemini) ขัดข้องหรือติดลิมิต บอทจะสลับไปใช้ **Groq (Llama 3)** อัตโนมัติ เพื่อให้ออเดอร์ไม่สะดุด

5. **News Filter (ระบบหลบข่าว):** 
   ดึงปฏิทินข่าวเศรษฐกิจ (USD High Impact) จาก ForexFactory หากมีข่าวแดง AI จะรับทราบและปรับความเสี่ยงให้

6. **Live Dashboard:**
   มาพร้อมหน้าเว็บ UI โทนดาร์กสไตล์ Terminal ให้คุณสามารถเปิดเข้าไปดู:
   - สเตตัสการรันรอบถัดไป
   - เหตุผล (Triggers) ที่ปลุก AI ขึ้นมาทำงานรอบล่าสุด
   - แผนการเทรดล่าสุด และ Log การทำงานแบบ Real-time

---

## 🚀 วิธีการติดตั้ง (Deployment)

เราจะใช้ **Render.com** (รันเซิร์ฟเวอร์ฟรี 24 ชม.) ควบคู่กับ **UptimeRobot** (คอยปิงเพื่อป้องกันเซิร์ฟเวอร์หลับ)

### ขั้นตอนที่ 1: ขอ API Keys ที่จำเป็น (ฟรีทั้งหมด)
- `GEMINI_API_KEY`: ขอจาก [Google AI Studio](https://aistudio.google.com/)
- `GROQ_API_KEY`: ขอจาก [Groq Cloud](https://console.groq.com/keys) (เผื่อเป็น AI สำรอง)
- `TELEGRAM_BOT_TOKEN`: ขอจาก [@BotFather](https://t.me/BotFather) บน Telegram
- `TELEGRAM_CHAT_ID`: ใช้ [@userinfobot](https://t.me/userinfobot) เพื่อดูรหัสแชทของคุณ

### ขั้นตอนที่ 2: ฝากโค้ดไว้บน GitHub
1. Fork หรืออัปโหลดโค้ดชุดนี้ขึ้น GitHub Repository ของคุณ

### ขั้นตอนที่ 3: นำโค้ดไปรันบน Render.com
1. สมัครและเข้าสู่ระบบ [Render](https://render.com/)
2. กด **New +** แล้วเลือก **Web Service**
3. เลือก **Build and deploy from a Git repository** และเชื่อมต่อกับ GitHub ของคุณ
4. ตั้งค่าโปรเจกต์ตามนี้:
   - **Name:** xau-sentinel (หรือชื่ออะไรก็ได้)
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. เลื่อนลงมาที่ **Environment Variables** (กด Advanced) และใส่ค่าทั้ง 4 ตัว:
   - `GEMINI_API_KEY`
   - `GROQ_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
6. กด **Create Web Service** และรอจนกว่า Render จะรันเสร็จ คุณจะได้ URL ของเซิร์ฟเวอร์มา (เช่น `https://xau-sentinel.onrender.com`) **ลิงก์นี้คือหน้า Dashboard ของคุณ!**

### ขั้นตอนที่ 4: ตั้งค่า UptimeRobot (ปลุกบอท 24 ชม.)
Render แบบฟรีจะ "หลับ (Sleep)" ถ้าไม่มีคนเข้าเว็บเกิน 15 นาที เราจึงต้องใช้ UptimeRobot ในการยิงปลุกมันทุกๆ 10 นาที
1. ไปที่ [UptimeRobot](https://uptimerobot.com/) สมัครสมาชิกฟรี
2. กด **Add New Monitor**
3. ตั้งค่าตามนี้:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** XAU Sentinel Awake
   - **URL (or IP):** ใส่ URL ของ Render ตามด้วย `/api/status`
   - **Monitoring Interval:** 10 minutes
4. กด **Create Monitor**
5. **เสร็จสิ้น!** 🎉 ตอนนี้บอทและ Dashboard ของคุณจะออนไลน์ตลอด 24 ชั่วโมง

---

## 💻 ทดสอบในเครื่อง (Local Testing)

หากต้องการดัดแปลงโค้ดและทดสอบในคอมพิวเตอร์ของคุณเอง:

```bash
# 1. ติดตั้ง Dependencies
npm install

# 2. สร้างไฟล์ .env และใส่ API Keys ของคุณ
# GEMINI_API_KEY=xxx
# GROQ_API_KEY=gsk_xxx
# TELEGRAM_BOT_TOKEN=xxx
# TELEGRAM_CHAT_ID=xxx

# 3. รันสคริปต์จำลองเหตุการณ์เสมือนจริง (ข้ามเวลารอ)
npm run test:cron

# 4. ทดสอบความถูกต้องของสูตร (Unit Tests)
npm test

# 5. เปิดเซิร์ฟเวอร์ (บอทรันจริงทุก 15 นาที พร้อมเปิดหน้าเว็บ Dashboard บน localhost:3000)
npm start
```
