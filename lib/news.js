import { fetchWithRetry } from './utils.js';

/**
 * ดึงข่าวเศรษฐกิจระดับ High Impact ของ USD ประจำวันนี้
 * @returns {Promise<string>} ข้อมูลข่าวแบบสรุป
 */
export async function getUpcomingHighImpactNews() {
    try {
        const response = await fetchWithRetry(() => fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json'));
        if (!response.ok) {
            console.warn("⚠️ ไม่สามารถดึงข่าวจาก ForexFactory ได้:", response.statusText);
            return "ไม่มีข้อมูลข่าวเศรษฐกิจ (ดึงข้อมูลล้มเหลว)";
        }
        
        const data = await response.json();
        const now = new Date();
        const endOfDay = new Date(now);
        endOfDay.setUTCHours(23, 59, 59, 999);

        // กรองเฉพาะข่าว USD สีแดง (High Impact) ที่กำลังจะเกิดหรือเพิ่งเกิดในวันนี้
        const usdHighNews = data.filter(item => {
            if (item.country !== 'USD' || item.impact !== 'High') return false;
            
            const newsDate = new Date(item.date);
            // เอาเฉพาะข่าววันนี้ (เช็คแบบกว้างๆ ให้ครอบคลุม 24 ชม. ถัดไปหรือในวันเดียวกัน)
            // หรือข่าวที่กำลังจะเกิดขึ้นในอีกไม่กี่ชั่วโมง
            const hoursDiff = (newsDate - now) / (1000 * 60 * 60);
            
            // ข่าวตั้งแต่อดีต 12 ชม. ถึงอนาคต 24 ชม. 
            return hoursDiff >= -12 && hoursDiff <= 24;
        });

        if (usdHighNews.length === 0) {
            return "วันนี้ไม่มีข่าวเศรษฐกิจ USD รุนแรง (High Impact) สามารถเทรดเทคนิคอลได้ตามปกติ";
        }

        // จัดรูปแบบตารางข่าว
        let newsSummary = "🚨 ข่าวแดง USD วันนี้:\n";
        usdHighNews.forEach(news => {
            const dateObj = new Date(news.date);
            // แสดงเวลาแบบท้องถิ่น หรือ UTC
            const timeStr = dateObj.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
            newsSummary += `- เวลา ${timeStr} น. (ไทย): ${news.title}\n`;
        });

        return newsSummary.trim();

    } catch (error) {
        console.error("❌ ขัดข้องในการดึงข่าว:", error.message);
        return "ไม่สามารถโหลดตารางข่าวได้ ให้ระมัดระวังความผันผวน";
    }
}
