# XAU Sentinel 🤖📈 (Hybrid 24/7 Edition)

ระบบดึงข้อมูลตลาดทองคำ (XAUUSD) อัตโนมัติจาก Deriv API → ตรวจสอบข่าวเศรษฐกิจ → วิเคราะห์ด้วย Gemini AI → แจ้งเตือนเข้า Telegram 

ออกแบบให้ทำงานแบบ **Server 24/7** บน **Render.com** ควบคู่กับ **UptimeRobot** เพื่อให้บอทเฝ้ากราฟตลอดเวลาโดยไม่ต้องพึ่งพามนุษย์

## 🌟 ฟีเจอร์หลัก (Features)
1. **Algorithmic Scout (ทหารพราน):** บอทจะตื่นมาเช็คกราฟและข่าวทุกๆ 15 นาที หากตลาดนิ่ง (Sideway) บอทจะหลับต่อเพื่อประหยัดโควต้า AI แต่หากเกิดสัญญาณรุนแรง (เช่น M15 RSI ทะลุโซน 35/65) บอทจะส่งให้ AI วิเคราะห์ทันที
2. **Multi-Timeframe Analysis (MTFA):** ดึงกราฟ H1 (ดูเทรนด์ใหญ่) และ M15 (หาจุดเข้าที่เฉียบคม) ไปพร้อมกัน
3. **News Filter (ระบบหลบข่าว):** ดึงปฏิทินข่าวเศรษฐกิจ (USD High Impact) จาก ForexFactory แบบ Real-time เพื่อเตือน AI ไม่ให้เข้าเทรดในช่วงที่มีข่าวแรง (เช่น NFP, CPI)
4. **Market Closed Detection:** บอทรู้ว่าวันหยุดเสาร์-อาทิตย์ตลาดปิด และจะหยุดทำงานอัตโนมัติ
5. **Anti-Spam Cooldown:** เมื่อส่งแผนเทรดแล้ว บอทจะหยุดส่งสัญญาณซ้ำซ้อนเป็นเวลา 2 ชั่วโมง

---

## 🚀 วิธีการติดตั้ง (Deployment)

เราจะใช้ **Render.com** (รันเซิร์ฟเวอร์ฟรี 24 ชม.) และ **UptimeRobot** (คอยปิงเพื่อป้องกันเซิร์ฟเวอร์หลับ)

### ขั้นตอนที่ 1: ขอ API Keys ที่จำเป็น (ฟรีทั้งหมด)
- `GEMINI_API_KEY`: ขอจาก [Google AI Studio](https://aistudio.google.com/)
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
5. เลื่อนลงมาที่ **Environment Variables** (กด Advanced) และใส่ค่าทั้ง 3 ตัว:
   - `GEMINI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
6. กด **Create Web Service** และรอจนกว่า Render จะรันเสร็จ (คุณจะได้ URL ของเซิร์ฟเวอร์มา เช่น `https://xau-sentinel.onrender.com`)

### ขั้นตอนที่ 4: ตั้งค่า UptimeRobot (ปลุกบอท 24 ชม.)
Render แบบฟรีจะ "หลับ (Sleep)" ถ้าไม่มีคนเข้าเว็บเกิน 15 นาที เราจึงต้องใช้ UptimeRobot ในการยิงปลุกมันทุกๆ 10 นาที
1. ไปที่ [UptimeRobot](https://uptimerobot.com/) สมัครสมาชิกฟรี
2. กด **Add New Monitor**
3. ตั้งค่าตามนี้:
   - **Monitor Type:** HTTP(s)
   - **Friendly Name:** XAU Sentinel Awake
   - **URL (or IP):** ใส่ URL ของ Render ตามด้วย `/ping` (ตัวอย่าง: `https://xau-sentinel.onrender.com/ping`)
   - **Monitoring Interval:** 10 minutes
4. กด **Create Monitor**
5. **เสร็จสิ้น!** 🎉 ตอนนี้บอทคุณจะตื่นตลอด 24 ชั่วโมง (จันทร์-ศุกร์) และจะส่งแผนเทรดเข้า Telegram เมื่อถึงจุดที่กราฟสวยที่สุดเท่านั้น

---

## 💻 ทดสอบในเครื่อง (Local Testing)

หากต้องการดัดแปลงโค้ดและทดสอบในคอมพิวเตอร์ของคุณเอง:

```bash
# 1. ติดตั้ง Dependencies
npm install

# 2. สร้างไฟล์ .env และใส่ API Keys ของคุณ
# GEMINI_API_KEY=xxx
# TELEGRAM_BOT_TOKEN=xxx
# TELEGRAM_CHAT_ID=xxx

# 3. รันสคริปต์ทดสอบ (รันปุ๊บ ส่งแจ้งเตือนปั๊บ)
npm test

# 4. หรือ เปิดเซิร์ฟเวอร์จำลอง (รัน Loop ทุก 15 นาทีเหมือนของจริง)
npm start
```
