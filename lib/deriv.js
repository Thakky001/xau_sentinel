import WebSocket from 'ws';

// ============================================================
// Opt 2: fetchDerivMultiCandles — เปิด WebSocket ครั้งเดียว
//        แล้วขอข้อมูลหลาย timeframe ผ่าน req_id
// ============================================================

/**
 * ดึงข้อมูลหลาย Timeframe พร้อมกันผ่าน WebSocket connection เดียว
 * @param {Array<{granularity: number, count: number}>} requests - รายการ timeframe ที่ต้องการ
 * @returns {Promise<Object[]>} ข้อมูล OHLCV + Indicators ตามลำดับที่ขอ
 */
export function fetchDerivMultiCandles(requests) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        // เก็บผลลัพธ์แต่ละ request โดย req_id (0-based index)
        const results = new Array(requests.length).fill(null);
        let receivedCount = 0;

        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            ws.close();
            fn(arg);
        };

        const timeout = setTimeout(
            () => finish(reject, new Error('Deriv API timeout')),
            20000 // เผื่อเวลามากขึ้นเล็กน้อยเพราะส่งหลาย request
        );

        ws.on('open', () => {
            // ส่ง request ทุกตัวพร้อมกัน โดยใส่ req_id เพื่อจับคู่ response
            requests.forEach((req, idx) => {
                ws.send(JSON.stringify({
                    ticks_history: 'frxXAUUSD',
                    style: 'candles',
                    granularity: req.granularity,
                    count: req.count + 100, // buffer 100 แท่งเผื่อช่วงเปลี่ยนสัปดาห์
                    end: 'latest',
                    adjust_start_time: 1,
                    req_id: idx + 1  // req_id ต้องเป็น >= 1
                }));
            });
        });

        ws.on('message', (data) => {
            let response;
            try {
                response = JSON.parse(data.toString());
            } catch (e) {
                return finish(reject, new Error('Invalid JSON from Deriv API'));
            }

            if (response.error) {
                return finish(reject, new Error(`Deriv API Error: ${response.error.message}`));
            }

            if (response.msg_type === 'candles' && response.candles) {
                const reqIdx = (response.req_id || 1) - 1; // แปลงกลับเป็น 0-based
                const req = requests[reqIdx];

                if (!req) return; // ป้องกัน req_id ที่ไม่รู้จัก

                // Opt 3: mode 'light' สำหรับ H1 (ใช้แค่ EMA + ADX), 'full' สำหรับ M15
                const mode = req.mode || 'full';
                const targetCandles = response.candles.slice(-req.count);

                // ADX ต้องการอย่างน้อย period*2 = 28 แท่ง
                const MIN_CANDLES = 28;
                if (targetCandles.length < MIN_CANDLES) {
                    return finish(reject, new Error(
                        `Insufficient candles for req_id=${response.req_id}: got ${targetCandles.length}, need at least ${MIN_CANDLES}`
                    ));
                }

                results[reqIdx] = processCandles(targetCandles, mode);
                receivedCount++;

                // รอจนครบทุก response แล้วค่อย resolve
                if (receivedCount === requests.length) {
                    finish(resolve, results);
                }
            }
            // ignore other msg_types (e.g. ping) — รอ message ถัดไป
        });

        ws.on('error', (err) => finish(reject, err));
        ws.on('close', (code) => {
            // ถ้า settled แล้ว (finish ถูกเรียกแล้ว) ไม่ต้อง reject ซ้ำ
            if (!settled) finish(reject, new Error(`Deriv WebSocket closed unexpectedly (code: ${code})`));
        });
    });
}

/**
 * ดึงข้อมูลแท่งเทียน XAUUSD จาก Deriv WebSocket API (single timeframe)
 * @param {number} granularity - ขนาดแท่งเทียน (วินาที): 3600 = H1, 900 = M15
 * @param {number} count - จำนวนแท่งเทียนที่ต้องการ
 * @param {string} mode - 'full' (default) หรือ 'light' (เฉพาะ EMA+ADX)
 * @returns {Promise<Object>} ข้อมูล OHLCV + Indicators ที่คำนวณแล้ว
 */
export function fetchDerivCandles(granularity = 3600, count = 50, mode = 'full') {
    return fetchDerivMultiCandles([{ granularity, count, mode }])
        .then(results => results[0]);
}

// ============================================================
// Opt 3: processCandles — แยก mode 'light' (H1) / 'full' (M15)
// ============================================================

/**
 * คำนวณ Technical Indicators จากข้อมูลแท่งเทียน
 * @param {Array} candles - ข้อมูลแท่งเทียน
 * @param {'full'|'light'} mode - 'light' คำนวณแค่ EMA+ADX (ใช้กับ H1 ที่ Prompt ต้องการแค่เทรนด์)
 */
function processCandles(candles, mode = 'full') {
    const closes = candles.map(c => parseFloat(c.close));
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));

    const latest = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    // ข้อมูลพื้นฐาน (ใช้ทุก mode)
    const base = {
        price:      parseFloat(latest.close),
        open:       parseFloat(latest.open),
        high:       parseFloat(latest.high),
        low:        parseFloat(latest.low),
        prev_high:  parseFloat(prev.high),
        prev_low:   parseFloat(prev.low),
        prev_close: parseFloat(prev.close),
        ema_fast:   calcEMA(closes, 9),
        ema_slow:   calcEMA(closes, 21),
        adx:        calcADX(highs, lows, closes, 14),
    };

    // mode 'light' → คืนแค่ข้อมูลพื้นฐาน (H1 ใช้แค่ EMA + ADX แสดงเทรนด์)
    if (mode === 'light') return base;

    // mode 'full' → คำนวณ Indicator เพิ่มสำหรับ M15 (RSI, ATR, Price Action)
    const recentHighs = highs.slice(-20);
    const recentLows = lows.slice(-20);
    const recent_high = Math.max(...recentHighs);
    const recent_low = Math.min(...recentLows);

    return {
        ...base,
        recent_high,
        recent_low,
        rsi:                calcRSI(closes, 14),
        atr:                calcATR(highs, lows, closes, 14),
        candlestick_pattern: detectCandlestickPattern(latest, prev),
        fibo:               calcFibonacci(recent_high, recent_low),
        breakout:           checkBreakout(parseFloat(latest.close), recent_high, recent_low),
    };
}

// ============================================================
// Indicator Functions
// ============================================================

/**
 * สแกนหารูปแบบแท่งเทียนกลับตัว (Candlestick Pattern)
 */
export function detectCandlestickPattern(latest, prev) {
    const lOpen = parseFloat(latest.open);
    const lClose = parseFloat(latest.close);
    const lHigh = parseFloat(latest.high);
    const lLow = parseFloat(latest.low);
    const pOpen = parseFloat(prev.open);
    const pClose = parseFloat(prev.close);

    const lBody = Math.abs(lClose - lOpen);
    const lTotal = lHigh - lLow;

    // Pin Bar Logic
    const upperWick = lHigh - Math.max(lOpen, lClose);
    const lowerWick = Math.min(lOpen, lClose) - lLow;

    if (lTotal > 0) {
        if (lowerWick > lBody * 2 && upperWick < lBody) {
            return "Bullish Pin Bar (สัญญาณกลับตัวขึ้น/มีแรงซื้อต้านที่ปลายหาง)";
        }
        if (upperWick > lBody * 2 && lowerWick < lBody) {
            return "Bearish Pin Bar (สัญญาณกลับตัวลง/โดนเทขายที่ปลายหาง)";
        }
    }

    // Engulfing Logic
    const isLatestBullish = lClose > lOpen;
    const isPrevBearish = pClose < pOpen;
    const isLatestBearish = lClose < lOpen;
    const isPrevBullish = pClose > pOpen;

    if (isLatestBullish && isPrevBearish && lClose > pOpen && lOpen <= pClose) {
        return "Bullish Engulfing (แท่งเขียวกลืนกินแท่งแดงมิด)";
    }
    if (isLatestBearish && isPrevBullish && lClose < pOpen && lOpen >= pClose) {
        return "Bearish Engulfing (แท่งแดงกลืนกินแท่งเขียวมิด)";
    }

    return "ไม่มีรูปแบบกลับตัวที่ชัดเจน";
}

/**
 * ตรวจสอบ Micro Breakout
 */
function checkBreakout(currentClose, recentHigh, recentLow) {
    if (currentClose > recentHigh) return "ทะลุแนวต้าน (Bullish Breakout)";
    if (currentClose < recentLow) return "หลุดแนวรับ (Bearish Breakout)";
    return "ยังวิ่งอยู่ในกรอบ (Sideway)";
}

/**
 * คำนวณ Fibonacci Retracement ภายในกรอบ Swing
 */
export function calcFibonacci(recentHigh, recentLow) {
    const diff = recentHigh - recentLow;
    if (diff === 0) return null;
    return {
        level_38_2: parseFloat((recentLow + diff * 0.382).toFixed(2)), // 38.2% จากล่างขึ้นบน
        level_50_0: parseFloat((recentLow + diff * 0.500).toFixed(2)), // 50.0% (กึ่งกลาง)
        level_61_8: parseFloat((recentLow + diff * 0.618).toFixed(2)), // 61.8% จากล่างขึ้นบน (Golden Ratio)
    };
}

/**
 * คำนวณ RSI (Relative Strength Index) — ใช้ใน mode 'full' (M15)
 */
function calcRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;

    let gains = 0, losses = 0;

    // คำนวณ Average Gain/Loss เริ่มต้น
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Smoothed RSI (Wilder's method)
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
}

/**
 * คำนวณ EMA (Exponential Moving Average)
 */
function calcEMA(closes, period) {
    if (closes.length < period) return null;

    const multiplier = 2 / (period + 1);

    // เริ่มจาก SMA
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

    // คำนวณ EMA ต่อจาก SMA
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * multiplier + ema;
    }

    return parseFloat(ema.toFixed(2));
}

/**
 * คำนวณ ATR (Average True Range) — ใช้ใน mode 'full' (M15)
 */
function calcATR(highs, lows, closes, period = 14) {
    if (highs.length < period + 1) return null;

    const trueRanges = [];
    for (let i = 1; i < highs.length; i++) {
        const tr = Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1])
        );
        trueRanges.push(tr);
    }

    // ATR = SMA ของ True Range เริ่มต้น แล้วใช้ Wilder's Smoothing
    let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < trueRanges.length; i++) {
        atr = (atr * (period - 1) + trueRanges[i]) / period;
    }

    return parseFloat(atr.toFixed(2));
}

/**
 * คำนวณ ADX (Average Directional Index) — ใช้ทั้ง H1 และ M15
 */
function calcADX(highs, lows, closes, period = 14) {
    if (highs.length < period * 2) return null;

    let trs = [], pdms = [], ndms = [];

    for (let i = 1; i < highs.length; i++) {
        const upMove = highs[i] - highs[i - 1];
        const downMove = lows[i - 1] - lows[i];

        let pdm = 0, ndm = 0;
        if (upMove > downMove && upMove > 0) pdm = upMove;
        if (downMove > upMove && downMove > 0) ndm = downMove;

        pdms.push(pdm);
        ndms.push(ndm);

        const tr = Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1])
        );
        trs.push(tr);
    }

    const smooth = (arr, p) => {
        let smoothed = [arr.slice(0, p).reduce((a, b) => a + b, 0)];
        for (let i = p; i < arr.length; i++) {
            smoothed.push(smoothed[smoothed.length - 1] - (smoothed[smoothed.length - 1] / p) + arr[i]);
        }
        return smoothed;
    };

    const smoothedTR = smooth(trs, period);
    const smoothedPDM = smooth(pdms, period);
    const smoothedNDM = smooth(ndms, period);

    const dxs = [];
    for (let i = 0; i < smoothedTR.length; i++) {
        const tr = smoothedTR[i];
        const pdi = tr === 0 ? 0 : (smoothedPDM[i] / tr) * 100;
        const ndi = tr === 0 ? 0 : (smoothedNDM[i] / tr) * 100;
        const dx = (pdi + ndi) === 0 ? 0 : (Math.abs(pdi - ndi) / (pdi + ndi)) * 100;
        dxs.push(dx);
    }

    let adx = dxs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dxs.length; i++) {
        adx = ((adx * (period - 1)) + dxs[i]) / period;
    }

    return parseFloat(adx.toFixed(2));
}
