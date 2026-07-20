import WebSocket from 'ws';

/**
 * ดึงข้อมูลแท่งเทียน XAUUSD จาก Deriv WebSocket API
 * @param {number} granularity - ขนาดแท่งเทียน (วินาที): 3600 = H1, 14400 = H4, 86400 = D1
 * @param {number} count - จำนวนแท่งเทียนที่ต้องการ
 * @returns {Promise<Object>} ข้อมูล OHLCV + Indicators ที่คำนวณแล้ว
 */
export function fetchDerivCandles(granularity = 3600, count = 50) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            ws.close();
            fn(arg);
        };

        const timeout = setTimeout(() => finish(reject, new Error('Deriv API timeout')), 15000);

        ws.on('open', () => {
            // ขอข้อมูลแท่งเทียน XAUUSD
            ws.send(JSON.stringify({
                ticks_history: 'frxXAUUSD',
                style: 'candles',
                granularity: granularity,
                count: 5000, // ขอจำนวนเยอะเผื่อติดเสาร์-อาทิตย์ แล้วค่อยมาตัดออกทีหลัง
                end: 'latest',
                adjust_start_time: 1
            }));
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
                // ตัดเอาเฉพาะจำนวนแท่งเทียนที่ต้องการจากท้ายสุด (ล่าสุด)
                const targetCandles = response.candles.slice(-count);

                if (targetCandles.length < 34) {
                    return finish(reject, new Error(`Insufficient candles: got ${targetCandles.length}, need at least 34 for MACD calculation`));
                }
                return finish(resolve, processCandles(targetCandles));
            }
            // ignore other msg_types (e.g. ping) — รอ message ถัดไป
        });

        ws.on('error', (err) => finish(reject, err));
        ws.on('close', (code) => finish(reject, new Error(`Deriv WebSocket closed unexpectedly (code: ${code})`)));
    });
}

/**
 * คำนวณ Technical Indicators จากข้อมูลแท่งเทียน
 */
function processCandles(candles) {
    const closes = candles.map(c => parseFloat(c.close));
    const highs = candles.map(c => parseFloat(c.high));
    const lows = candles.map(c => parseFloat(c.low));
    
    const latest = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    // คำนวณ Swing High / Swing Low (รอบ 20 แท่งล่าสุด)
    const recentHighs = highs.slice(-20);
    const recentLows = lows.slice(-20);
    const recent_high = Math.max(...recentHighs);
    const recent_low = Math.min(...recentLows);

    return {
        // ข้อมูลแท่งเทียนล่าสุด
        price: parseFloat(latest.close),
        open: parseFloat(latest.open),
        high: parseFloat(latest.high),
        low: parseFloat(latest.low),
        
        // แท่งเทียนก่อนหน้า
        prev_high: parseFloat(prev.high),
        prev_low: parseFloat(prev.low),
        prev_close: parseFloat(prev.close),
        
        // Price Action
        recent_high: recent_high,
        recent_low: recent_low,
        candlestick_pattern: detectCandlestickPattern(latest, prev),
        fibo: calcFibonacci(recent_high, recent_low),
        
        // Technical Indicators (คำนวณเอง)
        rsi: calcRSI(closes, 14),
        ema_fast: calcEMA(closes, 9),
        ema_slow: calcEMA(closes, 21),
        macd: calcMACD(closes),
        atr: calcATR(highs, lows, closes, 14),
        adx: calcADX(highs, lows, closes, 14),
        breakout: checkBreakout(parseFloat(latest.close), recent_high, recent_low)
    };
}

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
        level_38_2: parseFloat((recentLow + diff * 0.618).toFixed(2)), // มองจากด้านบนลงมา
        level_50_0: parseFloat((recentLow + diff * 0.500).toFixed(2)),
        level_61_8: parseFloat((recentLow + diff * 0.382).toFixed(2)), // มองจากด้านบนลงมา
    };
}

/**
 * คำนวณ RSI (Relative Strength Index)
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
 * คำนวณ MACD (Moving Average Convergence Divergence)
 */
function calcMACD(closes) {
    const ema12 = calcEMAArray(closes, 12);
    const ema26 = calcEMAArray(closes, 26);
    
    if (!ema12 || !ema26) return { line: null, signal: null, hist: null };

    // MACD Line = EMA12 - EMA26
    const macdLine = [];
    const startIdx = Math.max(0, ema12.length - ema26.length);
    
    for (let i = 0; i < ema26.length; i++) {
        macdLine.push(ema12[startIdx + i] - ema26[i]);
    }

    // Signal Line = EMA9 ของ MACD Line
    const signalLine = calcEMAFromArray(macdLine, 9);
    
    if (!signalLine) return { line: null, signal: null, hist: null };

    const latestMACD = macdLine[macdLine.length - 1];
    const latestSignal = signalLine[signalLine.length - 1];

    return {
        line: parseFloat(latestMACD.toFixed(4)),
        signal: parseFloat(latestSignal.toFixed(4)),
        hist: parseFloat((latestMACD - latestSignal).toFixed(4))
    };
}

/**
 * คำนวณ ATR (Average True Range)
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
 * คำนวณ ADX (Average Directional Index)
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

// Helper: คืน EMA เป็น Array
function calcEMAArray(closes, period) {
    if (closes.length < period) return null;
    const multiplier = 2 / (period + 1);
    const emaArr = [];
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    emaArr.push(ema);
    for (let i = period; i < closes.length; i++) {
        ema = (closes[i] - ema) * multiplier + ema;
        emaArr.push(ema);
    }
    return emaArr;
}

function calcEMAFromArray(data, period) {
    if (data.length < period) return null;
    const multiplier = 2 / (period + 1);
    const emaArr = [];
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    emaArr.push(ema);
    for (let i = period; i < data.length; i++) {
        ema = (data[i] - ema) * multiplier + ema;
        emaArr.push(ema);
    }
    return emaArr;
}
