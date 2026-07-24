import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'fs';

// โหลดกุญแจลับจากไฟล์ JSON หรือจาก Environment Variable (สำหรับ Server)
let creds;
try {
    if (process.env.GOOGLE_CREDS_JSON) {
        // กรณีรันบน Server (Render/Heroku)
        creds = JSON.parse(process.env.GOOGLE_CREDS_JSON);
        console.log("🔑 โหลดกุญแจ Google จาก Environment Variable สำเร็จ");
    } else {
        // กรณีรันบน Local PC
        const rawdata = fs.readFileSync('./google-creds.json');
        creds = JSON.parse(rawdata);
        console.log("🔑 โหลดกุญแจ Google จากไฟล์ google-creds.json สำเร็จ");
    }
} catch (error) {
    console.error("⚠️ ไม่พบกุญแจ หรือไฟล์ google-creds.json ไม่ถูกต้อง กรุณาตั้งค่าตามคู่มือก่อนใช้งาน Tracking Mode");
}

let doc = null;
let trackingSheet = null;

/**
 * ฟังก์ชันเริ่มต้นเชื่อมต่อ Google Sheets และสร้างหัวตารางอัตโนมัติ
 */
export async function initGoogleSheets() {
    const SHEET_ID = process.env.GOOGLE_SHEET_ID;
    if (!creds || !SHEET_ID) {
        console.warn("⚠️ ขาดไฟล์ google-creds.json หรือยังไม่ได้ตั้งค่า GOOGLE_SHEET_ID ข้ามการโหลด Database...");
        return false;
    }

    try {
        // สร้าง Auth Client ด้วย JWT (กุญแจส่วนตัวของบอท)
        const serviceAccountAuth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: [
                'https://www.googleapis.com/auth/spreadsheets',
            ],
        });

        doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
        
        console.log("📊 กำลังเชื่อมต่อ Google Sheets...");
        await doc.loadInfo(); 
        console.log(`✅ เชื่อมต่อ Google Sheets สำเร็จ: ไฟล์ชื่อ "${doc.title}"`);

        // เลือกหน้าชีตแผ่นแรก
        trackingSheet = doc.sheetsByIndex[0];

        // เปลี่ยนชื่อชีตย่อยเป็น Tracking_DB
        if (trackingSheet.title !== 'Tracking_DB') {
            await trackingSheet.updateProperties({ title: 'Tracking_DB' });
        }

        // ตรวจสอบและสร้างหัวตารางอัตโนมัติ
        await setupHeaders();
        return true;

    } catch (error) {
        console.error("❌ เชื่อมต่อ Google Sheets ล้มเหลว:", error.message);
        return false;
    }
}

/**
 * ฟังก์ชันสร้างหัวตาราง (Headers) อัตโนมัติถ้ายังไม่มี
 */
async function setupHeaders() {
    const expectedHeaders = [
        'Order_ID',
        'Timestamp',
        'Action',
        'Entry_Price',
        'Lot_Size',
        'SL_Price',
        'TP_Price',
        'BE_Price',
        'Status',
        'Close_Price',
        'PnL',
        'Reason'
    ];

    try {
        // ลองดึงหัวตารางเดิมมาเช็ค
        await trackingSheet.loadHeaderRow();
        const currentHeaders = trackingSheet.headerValues;
        
        // ถ้าน้อยกว่าที่ควรจะเป็น (อาจจะลบผิด หรือยังกรอกไม่ครบ) ให้เขียนทับเลย
        if (currentHeaders.length < expectedHeaders.length) {
            console.log("⚠️ หัวตารางเก่าไม่ครบถ้วน กำลังปรับปรุงหัวตารางใหม่...");
            await trackingSheet.setHeaderRow(expectedHeaders);
            console.log("✅ ปรับปรุงหัวตารางเรียบร้อย!");
        }
    } catch (error) {
        // ถ้า loadHeaderRow() พัง แปลว่าตารางนี้ว่างเปล่า (Blank sheet)
        console.log("📝 ตารางนี้ยังว่างเปล่า บอทกำลังเสกหัวตารางให้แบบอัตโนมัติ...");
        await trackingSheet.setHeaderRow(expectedHeaders);
        console.log("✅ สร้างหัวตาราง (Headers) อัตโนมัติเรียบร้อย!");
    }
}

/**
 * อัปเดตข้อมูลออเดอร์ใน Google Sheets (เมื่อปิดไม้)
 */
export async function updateOrderInSheet(orderId, updateData) {
    if (!trackingSheet) return;
    try {
        const rows = await trackingSheet.getRows();
        // ค้นหาแถวที่มี Order_ID ตรงกัน
        const row = rows.find(r => r.get('Order_ID') === orderId);
        if (row) {
            if (updateData.Status) row.set('Status', updateData.Status);
            if (updateData.Close_Price) row.set('Close_Price', updateData.Close_Price);
            if (updateData.PnL) row.set('PnL', updateData.PnL);
            if (updateData.Reason) row.set('Reason', updateData.Reason);
            await row.save();
            console.log(`✅ อัปเดตสถานะออเดอร์ [${orderId}] ในชีตเรียบร้อย (${updateData.Status})`);
        }
    } catch (e) {
        console.error("❌ อัปเดตชีตไม่สำเร็จ:", e.message);
    }
}

/**
 * บันทึกออเดอร์ใหม่ลงใน Google Sheets
 */
export async function logOrderToSheet(order) {
    if (!trackingSheet) {
        console.error("⚠️ ไม่สามารถบันทึกออเดอร์ได้ เนื่องจากยังไม่ได้เชื่อมต่อ Google Sheets");
        return null;
    }

    try {
        const row = {
            Order_ID: order.id,
            Timestamp: new Date(order.ts).toISOString(),
            Action: order.action,
            Entry_Price: order.entry,
            Lot_Size: 0.01,
            SL_Price: order.sl,
            TP_Price: order.tp,
            BE_Price: order.be || '-',
            Status: 'OPEN',
            Close_Price: '-',
            PnL: '-',
            Reason: '-'
        };

        const addedRow = await trackingSheet.addRow(row);
        console.log(`📝 บันทึกออเดอร์ [${order.id}] ลง Google Sheets สำเร็จ!`);
        return addedRow;
    } catch (error) {
        console.error("❌ เกิดข้อผิดพลาดในการบันทึกชีต:", error.message);
        return null;
    }
}
