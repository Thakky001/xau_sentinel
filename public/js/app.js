const $ = id => document.getElementById(id);

// ── Utilities ──────────────────────────────────────────────
function fmtTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString('th-TH', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'Asia/Bangkok'
    });
}

function fmtAgo(ts) {
    if (!ts) return '';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return `${diff} วินาทีที่แล้ว`;
    if (diff < 3600) return `${Math.floor(diff/60)} นาทีที่แล้ว`;
    return `${Math.floor(diff/3600)} ชั่วโมงที่แล้ว`;
}

function formatCountdown(ms) {
    if (ms <= 0) return '00:00';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function pill(text, color) {
    return `<span class="pill ${color}">${text}</span>`;
}

// ── State ──────────────────────────────────────────────────
let state = null;

// ── Fetch & Render ─────────────────────────────────────────
async function fetchStatus() {
    try {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error('API error');
        state = await res.json();
        render(state);
        $('online-badge').className = 'badge';
        $('online-badge').innerHTML = '<span class="dot"></span> ONLINE';
    } catch (e) {
        $('online-badge').className = 'badge offline';
        $('online-badge').innerHTML = '<span class="dot"></span> OFFLINE';
    }
}

function render(s) {
    // ── Market ──
    if (s.isMarketOpen) {
        $('market-status').innerHTML = pill('⚡ ตลาดเปิด', 'green');
    } else {
        $('market-status').innerHTML = pill('🔒 ตลาดปิด', 'red');
    }
    const sessionShort = (s.currentSession || '').split(' ')[0] + ' ' + (s.currentSession || '').split(' ').slice(1,3).join(' ');
    $('market-session').textContent = s.currentSession || '—';

    // ── Bot Status ──
    if (s.isRunning) {
        $('bot-status').innerHTML = pill('⚙️ กำลังวิเคราะห์...', 'gold');
    } else if (s.isInCooldown) {
        $('bot-status').innerHTML = pill('⏳ Cooldown', 'yellow');
    } else {
        $('bot-status').innerHTML = pill('✅ พร้อม', 'green');
    }
    $('last-run-time').textContent = s.lastRunAt
        ? `รันล่าสุด: ${fmtTime(s.lastRunAt)}`
        : 'ยังไม่ได้รันในเซสชันนี้';

    // ── Cooldown ──
    if (s.isInCooldown && s.cooldownEndsAt) {
        const remaining = s.cooldownEndsAt - Date.now();
        $('cooldown-val').innerHTML = pill(`⏳ ${formatCountdown(remaining)}`, 'yellow');
        $('cooldown-sub').textContent = `Cooldown หมด: ${fmtTime(s.cooldownEndsAt)}`;
    } else if (s.lastAlertAt) {
        $('cooldown-val').innerHTML = pill('✅ พร้อมส่งสัญญาณ', 'green');
        $('cooldown-sub').textContent = `ส่งล่าสุด: ${fmtTime(s.lastAlertAt)}`;
    } else {
        $('cooldown-val').innerHTML = pill('✅ พร้อมส่งสัญญาณ', 'green');
        $('cooldown-sub').textContent = 'ยังไม่เคยส่งสัญญาณ';
    }

    // ── Portfolio & Paper Trading ──
    if (s.portfolio) {
        // Balance
        const balanceVal = parseFloat(s.portfolio.balance).toFixed(2);
        $('portfolio-balance').textContent = `$${balanceVal}`;
        const isProfit = s.portfolio.balance > 100;
        const isLoss = s.portfolio.balance < 100;
        $('portfolio-balance').className = `card-value font-mono ${isProfit ? 'text-green' : isLoss ? 'text-red' : ''}`;

        // Active Orders
        const orders = s.portfolio.activeOrders || [];
        if (orders.length === 0) {
            $('active-orders').innerHTML = '<div class="empty-state">พอร์ตว่างเปล่า 💸<br><small>รอสัญญาณเข้าเทรด...</small></div>';
        } else {
            $('active-orders').innerHTML = '<div class="order-list">' + orders.map(o => `
                <div class="order-item">
                    <div class="order-info">
                        <span class="order-id">${pill(o.action, o.action === 'BUY' ? 'green' : 'red')} ${o.id}</span>
                        <span class="order-prices">Entry: <b>${o.entry}</b></span>
                    </div>
                    <div class="order-info" style="align-items:flex-end">
                        <span class="order-prices">TP: <b class="text-green">${o.tp}</b></span>
                        <span class="order-prices">SL: <b class="text-red">${o.sl}</b></span>
                    </div>
                </div>
            `).join('') + '</div>';
        }
    }

    // ── Last Analysis ──
    if (s.lastAnalysis) {
        const a = s.lastAnalysis;
        $('analysis-ago').textContent = '— ' + fmtAgo(a.ts);
        const decClass = `decision-${a.decision}`;
        
        let decisionHtml = pill(a.decision, a.decision === 'BUY' ? 'green' : a.decision === 'SELL' ? 'red' : 'yellow');
        
        $('analysis-content').innerHTML = `
            <div class="analysis-grid">
                <div class="metric-box">
                    <div class="metric-label">XAUUSD Price</div>
                    <div class="metric-value font-mono">$${a.price?.toLocaleString('en-US', {minimumFractionDigits:2})}</div>
                </div>
                <div class="metric-box">
                    <div class="metric-label">Decision</div>
                    <div class="metric-value ${decClass}" style="margin-top:2px">${a.decision}</div>
                </div>
                <div class="metric-box">
                    <div class="metric-label">RSI / ADX</div>
                    <div class="metric-value font-mono" style="font-size:1.1rem">
                        <span style="color:${a.rsi > 65 ? 'var(--red)' : a.rsi < 35 ? 'var(--green)' : 'var(--text)'}">${a.rsi}</span> / 
                        <span style="color:${a.adx > 25 ? 'var(--green)' : 'var(--yellow)'}">${a.adx ?? '—'}</span>
                    </div>
                </div>
            </div>
            
            <div style="font-size:.75rem;color:var(--text-dim);margin-bottom:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase">
                SESSION: <span style="color:var(--cyan)">${a.session}</span> | TREND: <span style="color:${a.trend === 'ขาขึ้น' ? 'var(--green)' : 'var(--red)'}">${a.trend}</span> | NEWS: <span>${a.hasNews ? pill('⚠️ มีข่าว', 'red') : pill('✅ ไม่มีข่าว', 'green')}</span>
            </div>
        `;

        if (a.triggers && a.triggers.length > 0) {
            $('analysis-content').innerHTML += `
            <div class="trigger-box">
                <div class="trigger-title">🔔 สัญญาณที่ตรวจพบ (${a.triggers.length})</div>
                <div class="trigger-list">
                    ${a.triggers.map(t => `<div class="trigger-item">${t}</div>`).join('')}
                </div>
            </div>`;
        }
    } else {
        $('analysis-ago').textContent = '';
        $('analysis-content').innerHTML = '<div class="empty-state">ยังไม่มีข้อมูลการวิเคราะห์ในเซสชันนี้<br><small style="opacity:.5">รอ AI ส่งสัญญาณ...</small></div>';
    }

    // ── Logs ──
    const logs = s.logs || [];
    $('log-count').textContent = `${logs.length} ITEMS`;
    if (logs.length === 0) {
        $('log-container').innerHTML = '<div class="empty-state">System initialized. Awaiting processes...</div>';
    } else {
        $('log-container').innerHTML = logs.map(l => {
            const time = new Date(l.ts).toLocaleTimeString('th-TH', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                timeZone: 'Asia/Bangkok'
            });
            const msg = l.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `<div class="log-row ${l.level}">
                <span class="log-time">${time}</span>
                <span class="log-level ${l.level}">${l.level.toUpperCase()}</span>
                <span class="log-msg">${msg}</span>
            </div>`;
        }).join('');
    }
}

// ── Countdown Timer (runs every second in browser) ─────────
function tickCountdown() {
    if (!state || !state.nextRunAt) return;
    const ms = state.nextRunAt - Date.now();
    const el = $('countdown');
    const sub = $('next-run-time');

    if (ms <= 0) {
        el.textContent = '00:00';
        el.className = 'card-value font-mono countdown-soon text-gold';
        sub.textContent = 'Analyzing...';
    } else {
        el.textContent = formatCountdown(ms);
        el.className = 'card-value font-mono ' + (ms < 60000 ? 'text-gold' : '');
        sub.textContent = `Next scan: ${fmtTime(state.nextRunAt)}`;
    }

    // Update cooldown
    if (state.isInCooldown && state.cooldownEndsAt) {
        const remaining = state.cooldownEndsAt - Date.now();
        if (remaining > 0) {
            $('cooldown-val').innerHTML = `<span class="pill yellow" style="font-size:1.1rem;padding:8px 16px">⏳ ${formatCountdown(remaining)}</span>`;
        }
    }
}

// ── Init ───────────────────────────────────────────────────
fetchStatus();
setInterval(fetchStatus, 5000);
setInterval(tickCountdown, 1000);
