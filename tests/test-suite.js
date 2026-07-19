import assert from 'assert';
import { isMarketClosed } from '../lib/bot.js';
import { detectCandlestickPattern, calcFibonacci } from '../lib/deriv.js';
import { sanitizeForTelegram, splitTelegramMessage, escapeHtml } from '../lib/utils.js';
import { getUpcomingHighImpactNews } from '../lib/news.js';

console.log('🧪 Starting XAU Sentinel Comprehensive Test Suite...\n');

let passCount = 0;
let failCount = 0;

function runTest(testName, testFn) {
    try {
        testFn();
        console.log(`✅ PASS: ${testName}`);
        passCount++;
    } catch (error) {
        console.error(`❌ FAIL: ${testName}`);
        console.error(`   ${error.message}`);
        failCount++;
    }
}

// ---------------------------------------------------------
// Test Suite 1: Mathematical & Logic (deriv.js & bot.js)
// ---------------------------------------------------------
console.log('--- Suite 1: Logic & Math ---');

runTest('calcFibonacci() calculates 50% and 61.8% correctly', () => {
    const high = 4000;
    const low = 3900;
    // Diff = 100
    // 61.8% from top = Low + (100 * 0.382) = 3938.2
    // 50.0% from top = Low + (100 * 0.5) = 3950
    const fibo = calcFibonacci(high, low);
    assert.strictEqual(fibo.level_50_0, 3950);
    assert.strictEqual(fibo.level_61_8, 3938.2);
});

runTest('detectCandlestickPattern() detects Bullish Pin Bar', () => {
    const prev = { open: 4000, close: 3995, high: 4002, low: 3990 };
    const latest = { open: 3995, close: 4000, high: 4002, low: 3950 }; 
    // Body = 5. Lower wick = 45 (9x body). Upper wick = 2 (< body).
    const result = detectCandlestickPattern(latest, prev);
    assert.ok(result.includes('Bullish Pin Bar'), `Expected Bullish Pin Bar, got: ${result}`);
});

runTest('detectCandlestickPattern() detects Bullish Engulfing', () => {
    const prev = { open: 4000, close: 3990, high: 4002, low: 3988 }; // Bearish
    const latest = { open: 3985, close: 4005, high: 4008, low: 3980 }; // Bullish, opens lower, closes higher
    const result = detectCandlestickPattern(latest, prev);
    assert.ok(result.includes('Bullish Engulfing'), `Expected Bullish Engulfing, got: ${result}`);
});

runTest('isMarketClosed() returns true for Saturday', () => {
    // Saturday: July 18, 2026 12:00 UTC
    const saturdayDate = new Date('2026-07-18T12:00:00Z');
    assert.strictEqual(isMarketClosed(saturdayDate), true);
});

runTest('isMarketClosed() returns false for Wednesday', () => {
    // Wednesday: July 15, 2026 12:00 UTC
    const wednesdayDate = new Date('2026-07-15T12:00:00Z');
    assert.strictEqual(isMarketClosed(wednesdayDate), false);
});


// ---------------------------------------------------------
// Test Suite 2: Safety & Sanitization (utils.js)
// ---------------------------------------------------------
console.log('\n--- Suite 2: Sanitization ---');

runTest('sanitizeForTelegram() converts markdown ** to <b>', () => {
    const text = "Entry is **4000** and SL is **3900**";
    const cleaned = sanitizeForTelegram(text);
    assert.strictEqual(cleaned, "Entry is <b>4000</b> and SL is <b>3900</b>");
});

runTest('sanitizeForTelegram() removes unsupported tags', () => {
    const text = "<div><b>4000</b></div> <p>Test</p>";
    const cleaned = sanitizeForTelegram(text);
    assert.strictEqual(cleaned, "<b>4000</b> Test");
});

runTest('splitTelegramMessage() splits long text correctly', () => {
    const longText = "A".repeat(5000);
    const chunks = splitTelegramMessage(longText, 4096);
    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].length, 4096);
    assert.strictEqual(chunks[1].length, 5000 - 4096);
});


// ---------------------------------------------------------
// Test Suite 3: Async & External APIs (news.js)
// ---------------------------------------------------------
console.log('\n--- Suite 3: External APIs ---');

async function runAsyncTests() {
    try {
        const newsResult = await getUpcomingHighImpactNews();
        if (typeof newsResult === 'string' && newsResult.length > 0) {
            console.log(`✅ PASS: getUpcomingHighImpactNews() executes without crashing`);
            passCount++;
        } else {
            console.error(`❌ FAIL: getUpcomingHighImpactNews() returned empty/invalid result`);
            failCount++;
        }
    } catch (error) {
        console.error(`❌ FAIL: getUpcomingHighImpactNews() crashed with error: ${error.message}`);
        failCount++;
    }

    console.log('\n--------------------------------------');
    console.log(`🏁 TEST SUMMARY: ${passCount} Passed, ${failCount} Failed`);
    console.log('--------------------------------------');
    
    if (failCount > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

runAsyncTests();
