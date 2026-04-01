const esc = (s) => {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
};

export function renderDashboard(data) {
  const { overview, keyStats, errorDistribution, endpointStats, errorDetails } = data;

  const totalReqs = overview.total_requests || 0;
  const successCount = overview.success_count || 0;
  const errorCount = overview.error_count || 0;
  const successRate = totalReqs > 0 ? ((successCount / totalReqs) * 100).toFixed(1) : '-';
  const activeKeys = overview.active || 0;
  const totalKeys = overview.total || 0;

  const rateClass = successRate === '-' ? '' : (+successRate >= 90 ? 'good' : +successRate >= 70 ? 'warn' : 'bad');

  const keyRows = keyStats.map(k => `
    <tr>
      <td>${esc(k.gmail_email)}</td>
      <td><span class="badge ${k.is_active ? 'badge-ok' : 'badge-off'}">${k.is_active ? 'Active' : 'Disabled'}</span></td>
      <td class="num">${k.total_requests}</td>
      <td class="num ${k.error_count > 0 ? 'txt-err' : ''}">${k.error_count}</td>
      <td class="num">${k.requests_24h}</td>
      <td class="num">${k.success_24h}</td>
      <td class="num ${k.errors_24h > 0 ? 'txt-err' : ''}">${k.errors_24h}</td>
      <td class="ts">${esc(k.last_used_at) || '-'}</td>
    </tr>`).join('');

  const epRows = endpointStats.map(e => {
    const rate = e.total > 0 ? ((e.success / e.total) * 100).toFixed(1) + '%' : '-';
    return `
    <tr>
      <td>${esc(e.endpoint)}</td>
      <td class="num">${e.total}</td>
      <td class="num">${e.success}</td>
      <td class="num ${e.errors > 0 ? 'txt-err' : ''}">${e.errors}</td>
      <td class="num">${rate}</td>
    </tr>`;
  }).join('');

  const edRows = errorDistribution.map(e => `
    <tr>
      <td class="num">${e.response_status}</td>
      <td class="num">${e.count}</td>
    </tr>`).join('');

  const detailRows = errorDetails.map(d => {
    const msg = d.error_message || '';
    const short = msg.length > 300 ? msg.substring(0, 300) + '...' : msg;
    const needExpand = msg.length > 300;
    return `
    <tr>
      <td>${esc(d.gmail_email)}</td>
      <td class="num">${d.response_status}</td>
      <td class="err-cell">${needExpand
        ? `<details><summary>${esc(short)}</summary><pre class="err-full">${esc(msg)}</pre></details>`
        : `<span>${esc(short)}</span>`
      }</td>
      <td class="ts">${esc(d.request_timestamp)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>API Keys Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;color:#1f1f1f;line-height:1.5}
header{background:#1a73e8;color:#fff;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
header h1{font-size:20px;font-weight:600}
.actions{display:flex;align-items:center;gap:12px;font-size:13px}
.actions button{background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:4px;padding:4px 14px;cursor:pointer;font-size:13px}
.actions button:hover{background:rgba(255,255,255,.35)}
.actions label{cursor:pointer;user-select:none}
.actions .ts-info{opacity:.8}
.container{max-width:1400px;margin:0 auto;padding:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.card{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card .label{font-size:13px;color:#5f6368;margin-bottom:4px}
.card .value{font-size:28px;font-weight:700}
.card .value.good{color:#34a853}
.card .value.warn{color:#f9ab00}
.card .value.bad{color:#ea4335}
section{background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:20px;overflow:hidden}
section h2{font-size:15px;font-weight:600;padding:14px 20px;border-bottom:1px solid #e8eaed;background:#fafbfc}
.tbl-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f8f9fa;text-align:left;padding:8px 12px;font-weight:600;color:#5f6368;border-bottom:1px solid #e8eaed;white-space:nowrap}
td{padding:8px 12px;border-bottom:1px solid #f1f3f4}
tr:hover td{background:#f8f9fa}
.num{text-align:right;font-variant-numeric:tabular-nums}
.ts{white-space:nowrap;color:#5f6368;font-size:12px}
.txt-err{color:#ea4335;font-weight:600}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.badge-ok{background:#e6f4ea;color:#1e8e3e}
.badge-off{background:#fce8e6;color:#d93025}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
@media(max-width:768px){.two-col{grid-template-columns:1fr}}
.err-cell{max-width:500px;word-break:break-all;font-size:12px}
.err-cell details summary{cursor:pointer;color:#5f6368}
.err-full{white-space:pre-wrap;word-break:break-all;max-height:400px;overflow-y:auto;background:#f8f9fa;padding:8px;border-radius:4px;margin-top:6px;font-size:11px}
.empty{padding:24px;text-align:center;color:#9aa0a6}
</style>
</head>
<body>
<header>
  <h1>API Keys Dashboard</h1>
  <div class="actions">
    <span class="ts-info" id="refreshTime"></span>
    <button onclick="location.reload()">Refresh</button>
    <label><input type="checkbox" id="autoRefresh"> Auto (60s)</label>
  </div>
</header>
<div class="container">

  <div class="cards">
    <div class="card">
      <div class="label">Requests (24h)</div>
      <div class="value">${totalReqs}</div>
    </div>
    <div class="card">
      <div class="label">Success Rate (24h)</div>
      <div class="value ${rateClass}">${successRate === '-' ? '-' : successRate + '%'}</div>
    </div>
    <div class="card">
      <div class="label">Active Keys</div>
      <div class="value">${activeKeys} <span style="font-size:14px;color:#5f6368">/ ${totalKeys}</span></div>
    </div>
    <div class="card">
      <div class="label">Errors (24h)</div>
      <div class="value ${errorCount > 0 ? 'bad' : ''}">${errorCount}</div>
    </div>
  </div>

  <section>
    <h2>Key Status</h2>
    <div class="tbl-wrap">
    <table>
      <thead><tr>
        <th>Gmail</th><th>Status</th><th>Total Reqs</th><th>Errors</th>
        <th>24h Reqs</th><th>24h OK</th><th>24h Errors</th><th>Last Used</th>
      </tr></thead>
      <tbody>${keyRows || '<tr><td colspan="8" class="empty">No keys</td></tr>'}</tbody>
    </table>
    </div>
  </section>

  <div class="two-col">
    <section>
      <h2>Endpoint Stats (24h)</h2>
      <div class="tbl-wrap">
      <table>
        <thead><tr><th>Endpoint</th><th>Total</th><th>OK</th><th>Errors</th><th>Rate</th></tr></thead>
        <tbody>${epRows || '<tr><td colspan="5" class="empty">No data</td></tr>'}</tbody>
      </table>
      </div>
    </section>
    <section>
      <h2>Error Distribution (24h)</h2>
      <div class="tbl-wrap">
      <table>
        <thead><tr><th>Status Code</th><th>Count</th></tr></thead>
        <tbody>${edRows || '<tr><td colspan="2" class="empty">No errors</td></tr>'}</tbody>
      </table>
      </div>
    </section>
  </div>

  <section>
    <h2>Error Details (Latest ${errorDetails.length})</h2>
    <div class="tbl-wrap">
    <table>
      <thead><tr><th>Gmail</th><th>Status</th><th>Error Message</th><th>Time</th></tr></thead>
      <tbody>${detailRows || '<tr><td colspan="4" class="empty">No errors</td></tr>'}</tbody>
    </table>
    </div>
  </section>

</div>
<script>
document.getElementById('refreshTime').textContent = 'Updated: ' + new Date().toLocaleString();
let timer;
document.getElementById('autoRefresh').addEventListener('change', function() {
  if (this.checked) {
    timer = setInterval(() => location.reload(), 60000);
  } else {
    clearInterval(timer);
  }
});
</script>
</body>
</html>`;
}
