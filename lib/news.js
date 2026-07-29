import { fetchWithRetry } from './utils.js';

// ============================================================
// In-Memory Cache สำหรับข่าว ForexFactory
// บอทรันทุก 15 นาที แต่ข่าวเปลี่ยนแค่วันละครั้ง
// Cache 4 ชั่วโมง = ลดการยิง API จาก ~96 ครั้ง/วัน เหลือ ~6 ครั้ง/วัน
// ============================================================
let newsCache = {
    data: null,       // ข้อมูลข่าวดิบจาก API
    fetchedAt: 0,     // timestamp ที่ดึงมาล่าสุด
};
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 ชั่วโมง

/**
 * ดึงข้อมูลข่าวดิบจาก ForexFactory (พร้อม Cache)
 * @returns {Promise<Array|null>} ข้อมูลข่าวดิบ หรือ null ถ้าดึงไม่ได้
 */
async function fetchNewsData() {
    const now = Date.now();

    // ถ้า Cache ยังไม่หมดอายุ → ใช้ข้อมูลเดิมเลย
    if (newsCache.data && (now - newsCache.fetchedAt < CACHE_TTL_MS)) {
        console.log('📰 ใช้ข่าวจาก Cache (ยังไม่หมดอายุ)');
        return newsCache.data;
    }

    // Cache หมดอายุ → ดึงใหม่จาก API
    console.log('📰 กำลังดึงข่าวใหม่จาก ForexFactory...');
    const response = await fetchWithRetry(async () => {
        const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
        // โยน Error ให้ fetchWithRetry จัดการ retry ได้ถูกต้อง (รวม 429)
        if (!res.ok) {
            throw new Error(`ForexFactory API Error: ${res.status} ${res.statusText}`);
        }
        return res;
    });

    const data = await response.json();

    // บันทึกลง Cache
    newsCache.data = data;
    newsCache.fetchedAt = now;
    console.log(`📰 ดึงข่าวสำเร็จ! (${data.length} รายการ) — Cache ใหม่จะหมดอายุใน 4 ชั่วโมง`);

    return data;
}

/**
 * ดึงข่าวเศรษฐกิจระดับ High Impact ของ USD ประจำวันนี้
 * @returns {Promise<string>} ข้อมูลข่าวแบบสรุป
 */
export async function getUpcomingHighImpactNews() {
    try {
        const data = await fetchNewsData();

        if (!data) {
            return "ไม่มีข้อมูลข่าวเศรษฐกิจ (ดึงข้อมูลล้มเหลว)";
        }

        const now = new Date();

        // กรองเฉพาะข่าว USD สีแดง (High Impact) ในรอบ 24 ชม. ข้างหน้า
        const upcomingNews = data.filter(item => {
            if (item.country !== 'USD' || item.impact !== 'High') return false;
            const newsDate = new Date(item.date);
            const hoursDiff = (newsDate - now) / (1000 * 60 * 60);
            return hoursDiff > -1 && hoursDiff <= 24; // อนาคต 24 ชม. (รวมช่วง 1 ชม. หลังข่าวออก)
        });

        // กรองข่าวที่เพิ่งผ่านไป (1-6 ชม. ก่อน) เพื่อเตือนว่าตลาดอาจยังสะเทือน
        const recentPastNews = data.filter(item => {
            if (item.country !== 'USD' || item.impact !== 'High') return false;
            const newsDate = new Date(item.date);
            const hoursDiff = (newsDate - now) / (1000 * 60 * 60);
            return hoursDiff >= -6 && hoursDiff <= -1;
        });

        if (upcomingNews.length === 0 && recentPastNews.length === 0) {
            return "วันนี้ไม่มีข่าวเศรษฐกิจ USD รุนแรง (High Impact) สามารถเทรดเทคนิคอลได้ตามปกติ";
        }

        let newsSummary = '';
        if (upcomingNews.length > 0) {
            newsSummary += "🚨 ข่าวแดง USD ที่กำลังจะมา:\n";
            upcomingNews.forEach(news => {
                const dateObj = new Date(news.date);
                const timeStr = dateObj.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
                newsSummary += `- เวลา ${timeStr} น. (ไทย): ${news.title}\n`;
            });
        }
        if (recentPastNews.length > 0) {
            newsSummary += "📋 ข่าวแดงที่ผ่านไปแล้ว (ระวังแรงสะเทือน):\n";
            recentPastNews.forEach(news => {
                const dateObj = new Date(news.date);
                const timeStr = dateObj.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
                newsSummary += `- เวลา ${timeStr} น. (ไทย): ${news.title} (ผ่านแล้ว)\n`;
            });
        }

        return newsSummary.trim();

    } catch (error) {
        console.error("❌ ขัดข้องในการดึงข่าว:", error.message);

        // ถ้ายิง API ไม่ได้ แต่มี Cache เก่า → ใช้ Cache เก่าแทนดีกว่าไม่มีอะไรเลย
        if (newsCache.data) {
            console.log('📰 ใช้ข่าวจาก Cache เก่า (Stale) แทน เพราะ API ล้มเหลว');
            newsCache.fetchedAt = Date.now(); // ยืดอายุ Cache เพื่อไม่ให้ยิงซ้ำทุก 15 นาที
            // เรียกตัวเองอีกทีเพื่อ process ข้อมูล Cache เก่า (fetchNewsData จะ return cache)
            return getUpcomingHighImpactNews();
        }

        return "ไม่สามารถโหลดตารางข่าวได้ ให้ระมัดระวังความผันผวน";
    }
}

/**
 * ตรวจสอบว่ากำลังจะมีข่าว High Impact ในอีกกี่นาทีข้างหน้า (ใช้สำหรับ Liquidator)
 * อ่านจาก Cache ไม่ยิง API พร่ำเพรื่อ
 * @returns {boolean} true ถ้ามีข่าวแดงในอีกไม่เกิน 15 นาที
 */
export function isHighImpactNewsApproaching() {
    if (!newsCache.data) return false;

    const now = new Date();
    
    // หากมีข่าวแดง USD ที่จะเกิดในอีกไม่เกิน 15 นาทีข้างหน้า
    const approachingNews = newsCache.data.find(item => {
        if (item.country !== 'USD' || item.impact !== 'High') return false;
        const newsDate = new Date(item.date);
        const minutesDiff = (newsDate - now) / (1000 * 60);
        
        // กรองเฉพาะข่าวที่กำลังจะเกิดใน 0 ถึง 15 นาที
        return minutesDiff >= 0 && minutesDiff <= 15;
    });

    return !!approachingNews;
}

/**
 * ตรวจสอบว่าตอนนี้อยู่ในช่วง Blackout Zone ของข่าวแดงหรือไม่
 * Blackout = 1 ชั่วโมงก่อนข่าว ถึง 1 ชั่วโมงหลังข่าว
 * @returns {{isBlackout: boolean, reason: string}} 
 */
export function isWithinNewsBlackout() {
    if (!newsCache.data) return { isBlackout: false, reason: '' };

    const now = new Date();
    
    for (const item of newsCache.data) {
        if (item.country !== 'USD' || item.impact !== 'High') continue;
        const newsDate = new Date(item.date);
        const minutesDiff = (newsDate - now) / (1000 * 60);
        
        // Blackout Zone: 60 นาทีก่อนข่าว ถึง 60 นาทีหลังข่าว
        if (minutesDiff >= -60 && minutesDiff <= 60) {
            const timeStr = newsDate.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
            const when = minutesDiff >= 0 ? `อีก ${Math.round(minutesDiff)} นาทีจะมี` : `ผ่านไปแล้ว ${Math.abs(Math.round(minutesDiff))} นาที`;
            return {
                isBlackout: true,
                reason: `${item.title} (${timeStr} น.) — ${when}`
            };
        }
    }

    return { isBlackout: false, reason: '' };
}

