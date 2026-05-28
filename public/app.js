/* ============================================================
   FINTECH RADAR — app.js
   ============================================================ */

let data = { companies: [], themes: {}, issues: [], lastUpdated: null };
let activeView = 'companies';
let activeFilter = 'all';

/* ── INIT ─────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  // Nav tab clicks
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn));
  });
  loadData();
});

/* ── DATA ─────────────────────────────────────────────────── */

async function loadData() {
  try {
    const resp = await fetch('/api/data');
    if (!resp.ok) throw new Error('API error');
    data = await resp.json();
    updateSyncStatus();
    render();
  } catch(e) {
    document.getElementById('sync-status').innerHTML =
      '<span class="sync-dot stale"></span>error loading data';
    renderEmpty();
  }
}

async function triggerPoll() {
  const btn = document.getElementById('refresh-btn');
  btn.textContent = '↻ syncing…';
  btn.disabled = true;
  try {
    await fetch('/api/poll');
    await loadData();
  } catch(e) {
    console.error('Poll error:', e);
  }
  btn.textContent = '↻ Refresh';
  btn.disabled = false;
}

// Expose to HTML onclick
document.getElementById('refresh-btn').addEventListener('click', triggerPoll);

function updateSyncStatus() {
  const el = document.getElementById('sync-status');
  if (data.lastUpdated) {
    const ago = Math.round((Date.now() - new Date(data.lastUpdated)) / 86400000);
    const label = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago}d ago`;
    el.innerHTML = `<span class="sync-dot"></span>last issue: ${label}`;
  } else {
    el.innerHTML = `<span class="sync-dot stale"></span>no issues yet`;
  }
}

/* ── ROUTING ──────────────────────────────────────────────── */

function switchView(btn) {
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeView = btn.dataset.view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + activeView).classList.add('active');
  render();
}

function render() {
  if (activeView === 'companies') renderCompanies();
  else if (activeView === 'themes') renderThemes();
  else renderHistory();
}

/* ── HELPERS ──────────────────────────────────────────────── */

function fmt(n) {
  if (!n || n === 0) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + n;
}

function stageClass(s) {
  return s === 'pre-seed' ? 't-pre'
       : s === 'seed'     ? 't-seed'
       : s === 'series-a' ? 't-a'
       : 't-other';
}

function setFilter(f) {
  activeFilter = f;
  renderCompanies();
}

/* ── COMPANIES ────────────────────────────────────────────── */

function renderCompanies() {
  const metricsDiv  = document.getElementById('metrics');
  const filterDiv   = document.getElementById('co-filters');
  const tableDiv    = document.getElementById('co-table');

  // Metrics
  const early    = data.companies.filter(c => ['pre-seed','seed'].includes(c.stage)).length;
  const issueCount = data.issues?.length || 0;
  metricsDiv.innerHTML = [
    [data.companies.length, 'Companies'],
    [Object.keys(data.themes).length, 'Themes'],
    [early, 'Early stage'],
    [issueCount, 'Issues processed'],
  ].map(([v, l]) => `
    <div class="metric">
      <div class="metric-val">${v}</div>
      <div class="metric-lbl">${l}</div>
    </div>`).join('');

  // Stage filters
  const stages = [...new Set(data.companies.map(c => c.stage).filter(Boolean))];
  filterDiv.innerHTML =
    `<button class="pill ${activeFilter === 'all' ? 'on' : ''}" onclick="setFilter('all')">All</button>` +
    stages.map(s =>
      `<button class="pill ${activeFilter === s ? 'on' : ''}" onclick="setFilter('${s}')">${s}</button>`
    ).join('');

  // Sort & filter companies
  let cos = [...data.companies].sort((a, b) =>
    (b.mentions || 1) - (a.mentions || 1) ||
    (b.funding?.amountUSD || 0) - (a.funding?.amountUSD || 0)
  );
  if (activeFilter !== 'all') cos = cos.filter(c => c.stage === activeFilter);

  if (!cos.length) { renderEmpty(); return; }

  tableDiv.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Company</th>
          <th class="r">Raised</th>
          <th class="r">Valuation</th>
          <th>Likely exit</th>
        </tr>
      </thead>
      <tbody>
        ${cos.map(companyRow).join('')}
      </tbody>
    </table>`;
}

function companyRow(c) {
  const raised = c.funding?.amountUSD > 0
    ? fmt(c.funding.amountUSD)
    : (c.funding?.amount && c.funding.amount !== 'unknown' ? c.funding.amount : '—');

  const val = c.funding?.valuationUSD > 0
    ? fmt(c.funding.valuationUSD)
    : (c.funding?.valuation && c.funding.valuation !== 'unknown' ? c.funding.valuation : '—');

  const multi  = (c.mentions || 1) > 1;
  const themes = (c.themes || []).slice(0, 2).map(t => `<span class="tag t-theme">${t}</span>`).join('');
  const geo    = c.geography && c.geography !== 'unknown'
    ? `<span class="tag t-geo">${c.geography}</span>` : '';

  return `
    <tr>
      <td>
        <div style="display:flex;align-items:center;gap:2px;">
          <span class="seen-dot ${multi ? 'multi' : ''}"
                title="${multi ? `seen ${c.mentions}× across issues` : 'seen once'}"></span>
          <span class="co-name">${c.name}</span>
          <span class="tag ${stageClass(c.stage)}" style="margin-left:6px;">${c.stage}</span>
        </div>
        <div class="co-desc">${c.description || ''}</div>
        <div class="co-tags">${geo}${themes}</div>
      </td>
      <td>
        <div class="money">
          <div class="amt">${raised}</div>
          <div class="rnd">${c.funding?.round || ''}</div>
        </div>
      </td>
      <td>
        <div class="money">
          <div class="amt">${val}</div>
        </div>
      </td>
      <td>
        <div class="exit-who">${c.exit?.likelyAcquirer || c.exit?.likely || '—'}</div>
        <div class="exit-why">${c.exit?.acquirerRationale || ''}</div>
      </td>
    </tr>`;
}

function renderEmpty() {
  document.getElementById('co-table').innerHTML = `
    <div class="empty">
      <i class="ti ti-mail-forward"></i>
      <div class="empty-t">Waiting for your first issue</div>
      <div class="empty-s">
        Forward your TWIF emails to<br>
        <code>twif@rexlaro.resend.app</code><br><br>
        Then hit Refresh — companies appear within seconds.
      </div>
    </div>`;
}

/* ── THEMES ───────────────────────────────────────────────── */

function renderThemes() {
  const themes = Object.values(data.themes)
    .sort((a, b) => (b.momentum * (b.signalCount || 1)) - (a.momentum * (a.signalCount || 1)));

  const listDiv = document.getElementById('theme-list');

  if (!themes.length) {
    listDiv.innerHTML = `
      <div class="empty">
        <i class="ti ti-chart-line"></i>
        <div class="empty-t">No themes yet</div>
        <div class="empty-s">Themes appear once emails start arriving.</div>
      </div>`;
    return;
  }

  const maxM = Math.max(...themes.map(t => t.momentum * (t.signalCount || 1)));

  listDiv.innerHTML = themes.map((t, i) => {
    const pct = Math.round((t.momentum * (t.signalCount || 1)) / maxM * 100);
    const sc  = t.stage === 'early' ? 'se' : t.stage === 'growing' ? 'sg' : 'sm';
    return `
      <div class="theme-card">
        <div class="t-rank">${String(i + 1).padStart(2, '0')}</div>
        <div class="t-info">
          <div class="t-name-row">
            ${t.name}
            <span class="sbadge ${sc}">${t.stage || ''}</span>
          </div>
          <div class="t-desc">${t.description || ''}</div>
        </div>
        <div class="t-bar-out">
          <div class="t-bar-in" style="width:${pct}%"></div>
        </div>
        <div class="t-signals">${t.signalCount || 1}×</div>
      </div>`;
  }).join('');
}

/* ── HISTORY ──────────────────────────────────────────────── */

function renderHistory() {
  const issues  = data.issues || [];
  const listDiv = document.getElementById('history-list');

  if (!issues.length) {
    listDiv.innerHTML = `
      <div class="empty">
        <i class="ti ti-inbox"></i>
        <div class="empty-t">No issues yet</div>
        <div class="empty-s">Processed newsletter issues will appear here.</div>
      </div>`;
    return;
  }

  listDiv.innerHTML = issues.map(issue => `
    <div class="history-card">
      <div class="history-title">${issue.title || 'This Week in Fintech'}</div>
      <div class="history-meta">
        ${issue.date} · ${issue.companyCount || 0} companies ·
        ${issue.themeCount || 0} themes · received ${issue.receivedAt}
      </div>
    </div>`).join('');
}
