# XAU Sentinel 🤖📈 (Institutional Quant Edition)

ระบบ AI วิเคราะห์และแจ้งเตือนจุดเข้าเทรดทองคำ (XAUUSD) อัตโนมัติ โดยผสมผสาน **Quantitative Technical Analysis** เข้ากับพลังการคิดของ **Groq LLaMA 3 / Gemini AI** พร้อมระบบจำลองพอร์ต **(Paper Trading)** และการจัดการความเสี่ยงแบบกองทุนสถาบัน 

โปรเจกต์นี้ออกแบบมาให้ทำงานแบบ **Server 24/7** บน **Render.com** เก็บข้อมูลเข้า **Google Sheets** แบบ Real-time และส่งสัญญาณตรงเข้า **Telegram**

---

## 🌟 ฟีเจอร์ระดับสถาบันการเงิน (Institutional Features)

1. **Math-based Risk Engine (คำนวณความเสี่ยงด้วยคณิตศาสตร์):** 
   ระบบได้ยึดอำนาจการคำนวณ Stop Loss / Take Profit จาก AI โดยสมบูรณ์ เพื่อป้องกันอาการหลอน (Hallucination) บอทจะใช้ค่า **ATR (ความผันผวนจริงของตลาด)** ในการคำนวณระยะ SL (ATR x 1.5) และเป้าหมาย TP ที่ Risk:Reward 1:1.5 พร้อมกันชนค่า Spread & Slippage ตอนบังทุน (Break Even)

2. **Fractal Market Structure (วิเคราะห์โครงสร้างตลาดขั้นสูง):**
   ค้นหาจุด Swing High / Swing Low ด้วยอัลกอริทึม **Fractal (ZigZag)** เพื่อยืนยันเทรนด์ (HH, HL, LH, LL) ทำให้มีความแม่นยำระดับเดียวกับการตีเส้นของโปรเทรดเดอร์

3. **Active Scout Bot (ทหารพรานเฝ้ากราฟ):** 
   ดึงข้อมูลทุกๆ 15 นาที ผ่าน WebSocket API ตรวจสอบ 4 เงื่อนไข (RSI, Fibo Retracement, Price Action, Breakout, MACD) หากไม่เจอแนวโน้ม บอทจะหลับเพื่อไม่ให้ส่งสัญญาณรบกวน (ลด Noise)

4. **Paper Trading Portfolio & Circuit Breaker (จำลองพอร์ตแบบเรียลไทม์):**
   - **Google Sheets Database:** เมื่อ AI วิเคราะห์และออกออเดอร์ (BUY/SELL) ข้อมูลจะถูกจดลง Google Sheets อัตโนมัติ (Lot Size = 0.01)
   - **Real-time Tracker:** บอทอีกตัวจะดึงราคา **Tick-by-tick (รายวินาที)** เพื่อเฝ้าระวังออเดอร์ในตาราง หากราคาชน SL หรือ TP บอทจะทำหน้าที่เป็น Circuit Breaker ปิดออเดอร์ทันที
   - **PnL Calculator:** คำนวณกำไร/ขาดทุนเป็นเงินดอลลาร์ และแจ้งเตือนผลลัพธ์เข้า Telegram

5. **Multi-Timeframe Analysis (MTFA) & News Filter:** 
   วิเคราะห์กราฟ H1 (เทรนด์ใหญ่) ควบคู่กับ M15 (จุดเข้า) และหลบข่าวแดง (High Impact) จากปฏิทินเศรษฐกิจ ForexFactory แบบอัตโนมัติ

---

## 🚀 วิธีการติดตั้ง (Deployment)

เราจะใช้ **Render.com** (รันเซิร์ฟเวอร์ฟรี 24 ชม.) ควบคู่กับ **Google Sheets** (สำหรับเป็นฐานข้อมูล Paper Trading)

### ขั้นตอนที่ 1: ขอ API Keys ที่จำเป็น (ฟรีทั้งหมด)
- `GEMINI_API_KEY`: ขอจาก [Google AI Studio](https://aistudio.google.com/)
- `GROQ_API_KEY`: ขอจาก [Groq Cloud](https://console.groq.com/keys)
- `TELEGRAM_BOT_TOKEN`: ขอจาก [@BotFather](https://t.me/BotFather) 
- `TELEGRAM_CHAT_ID`: ใช้ [@userinfobot](https://t.me/userinfobot)

### ขั้นตอนที่ 2: ตั้งค่าฐานข้อมูล Google Sheets (Paper Trading)
1. สร้างไฟล์ Google Sheets เปล่าๆ ขึ้นมา 1 ไฟล์
2. สร้าง **Service Account** บน Google Cloud และดาวน์โหลดกุญแจลับ (ไฟล์ `.json`)
3. นำอีเมลของบอทไป Share ให้สิทธิ์เข้าถึงไฟล์ Google Sheets ของคุณ
4. ก๊อปปี้รหัสชีตยาวๆ จาก URL (รหัสหลัง /d/...) เตรียมไว้

### ขั้นตอนที่ 3: นำโค้ดไปรันบน Render.com
1. อัปโหลดโค้ดชุดนี้ขึ้น GitHub ของคุณ และเข้าสู่ระบบ [Render](https://render.com/)
2. กด **New +** > **Web Service** เลือก Repository ของคุณ
3. ตั้งค่า Build Command เป็น `npm install` และ Start Command เป็น `npm start`
4. ตั้งค่า **Environment Variables** ดังนี้:
   - `GEMINI_API_KEY`
   - `GROQ_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `GOOGLE_SHEET_ID`: (ใส่รหัสชีตยาวๆ จากสเต็ป 2)
   - `GOOGLE_CREDS_JSON`: (ก๊อปปี้ตัวอักษรทั้งหมดที่อยู่ในไฟล์กุญแจ `.json` มาแปะในช่องนี้)
5. กด Deploy! เมื่อบอทติดทำงานครั้งแรก มันจะวิ่งไปสร้างหัวตารางใน Google Sheets ให้อัตโนมัติทันที

---

## 💻 ทดสอบในเครื่อง (Local Testing)

หากต้องการดัดแปลงโค้ดและทดสอบในคอมพิวเตอร์ของคุณเอง:

```bash
# 1. ติดตั้ง Dependencies
npm install

# 2. นำไฟล์กุญแจจาก Google Cloud มาวางในโฟลเดอร์โปรเจกต์ เปลี่ยนชื่อเป็น google-creds.json

# 3. สร้างไฟล์ .env และใส่ค่าให้ครบ:
# GEMINI_API_KEY=xxx
# GROQ_API_KEY=gsk_xxx
# TELEGRAM_BOT_TOKEN=xxx
# TELEGRAM_CHAT_ID=xxx
# GOOGLE_SHEET_ID=xxx

# 4. ทดสอบบอทหาจุดเข้า (Scout Bot) แบบข้ามเวลา
npm run test:cron

# 5. เปิดเซิร์ฟเวอร์รันจริง (พร้อมเปิด Dashboard บน localhost:3000)
npm start
```
