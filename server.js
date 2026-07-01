#!/usr/bin/env node
'use strict';

/**
 * Claude Agents Dashboard — live monitor for parallel Claude Code sessions.
 *
 * Serves a single self-contained page that polls /api/sessions and shows, for
 * the top N most-recently-active sessions, what each one is doing right now.
 *
 * Usage: node server.js    (config via .env — see .env.example)
 */

const http = require('http');
const { spawn } = require('child_process');

const { loadConfig } = require('./lib/config');
const { scanSessions } = require('./lib/scan');

const config = loadConfig();

function renderPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Claude Sessions</title>
<style>
  :root{
    --bg:#0a0c11;--surface:#12151d;--surface2:#171b25;--border:#232838;--border2:#2e3446;
    --text:#e2e5ec;--text2:#8b92a7;--text3:#565d73;
    --green:#4acb8a;--accent:#6c8cff;--orange:#eca85a;--red:#e86060;--pink:#e26a9e;
    --mono:'SF Mono','JetBrains Mono','Fira Code',monospace;
    --font:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif;
  }
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;-webkit-font-smoothing:antialiased;line-height:1.4;padding:24px}
  .wrap{max-width:820px;margin:0 auto}
  .head{display:flex;align-items:baseline;gap:10px;margin-bottom:4px}
  .head h1{font-size:16px;font-weight:600;letter-spacing:-.01em}
  .head .meta{font-size:12px;color:var(--text3);margin-left:auto;font-variant-numeric:tabular-nums}
  .sub{font-size:11px;color:var(--text3);margin-bottom:18px}
  .sub b{color:var(--green);font-weight:600}

  .rows{display:flex;flex-direction:column;gap:8px}
  .row{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;transition:border-color .15s}
  .row.working{border-color:rgba(74,203,138,0.35)}
  .row .r1{display:flex;align-items:center;gap:10px}
  .dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;background:var(--text3)}
  .working .dot{background:var(--green);box-shadow:0 0 0 0 rgba(74,203,138,.5);animation:pulse 1.8s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(74,203,138,.5)}70%{box-shadow:0 0 0 7px rgba(74,203,138,0)}100%{box-shadow:0 0 0 0 rgba(74,203,138,0)}}
  .proj{font-size:14px;font-weight:600;letter-spacing:-.01em}
  .branch{font-size:10.5px;color:var(--text2);font-family:var(--mono);background:var(--surface2);padding:1px 7px;border-radius:4px}
  .model{font-size:9.5px;color:var(--text3);font-family:var(--mono);text-transform:uppercase;letter-spacing:.03em}
  .spacer{flex:1}
  .tok{font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums;font-family:var(--mono)}
  .pct{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
  .bar{height:5px;border-radius:3px;background:var(--surface2);overflow:hidden;margin:9px 0 8px}
  .bar .fill{height:100%;background:linear-gradient(90deg,var(--green),var(--accent));transition:width .5s ease}
  .bar .fill.warn{background:linear-gradient(90deg,var(--orange),var(--red))}
  .r2{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--text2)}
  .r2 .act{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .r2 .act .tool{font-family:var(--mono);color:var(--accent);font-weight:600}
  .r2 .act .tool.task{color:var(--pink)}
  .r2 .status{font-weight:600}
  .working .r2 .status{color:var(--green)}
  .idle .r2 .status{color:var(--text3)}
  .r2 .ago{margin-left:auto;color:var(--text3);font-variant-numeric:tabular-nums;flex-shrink:0}
  .empty{text-align:center;padding:60px 20px;color:var(--text3)}
  .empty .e{font-size:34px;margin-bottom:10px;opacity:.3}
  .foot{margin-top:18px;font-size:10px;color:var(--text3);text-align:center}
  .off{color:var(--red)}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>⚡ Claude Sessions</h1>
    <span class="meta" id="meta"></span>
  </div>
  <div class="sub" id="sub"></div>
  <div class="rows" id="rows"><div class="empty"><div class="e">◌</div>Loading…</div></div>
  <div class="foot" id="foot"></div>
</div>
<script>
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtTok(n){if(n>=1e6)return (n/1e6).toFixed(2)+'M';if(n>=1e3)return (n/1e3).toFixed(1)+'k';return String(n||0);}
function ago(ms){var s=Math.max(0,Math.round((Date.now()-ms)/1000));if(s<60)return s+'s';var m=Math.round(s/60);if(m<60)return m+'m';var h=Math.round(m/60);if(h<24)return h+'h';return Math.round(h/24)+'d';}
function render(d){
  document.getElementById('meta').textContent=new Date(d.generatedAt).toLocaleTimeString();
  var procs = d.runningClaudeProcs==null?'':' · '+d.runningClaudeProcs+' claude proc'+(d.runningClaudeProcs===1?'':'s');
  document.getElementById('sub').innerHTML='<b>'+d.totals.active+'</b> active · top '+d.maxSessions+procs;
  var rows=document.getElementById('rows');
  if(!d.sessions.length){rows.innerHTML='<div class="empty"><div class="e">◌</div>No recent sessions in the lookback window.</div>';return;}
  rows.innerHTML=d.sessions.map(function(s){
    var pct=s.contextPct||0, warn=pct>=70?' warn':'';
    var act=s.activity?('<span class="tool'+(s.activity.tool==='Task'?' task':'')+'">'+esc(s.activity.tool)+'</span>'+(s.activity.detail?' '+esc(s.activity.detail):'')):'<span style="color:var(--text3)">no tool activity</span>';
    var statusTxt=s.status==='working'?'working':'idle';
    return '<div class="row '+s.status+'">'+
      '<div class="r1">'+
        '<span class="dot"></span>'+
        '<span class="proj">'+esc(s.project)+'</span>'+
        (s.gitBranch?'<span class="branch">'+esc(s.gitBranch)+'</span>':'')+
        '<span class="model">'+esc(s.model)+'</span>'+
        '<span class="spacer"></span>'+
        '<span class="tok">'+fmtTok(s.tokens)+' / '+esc(s.contextWindowLabel)+'</span>'+
        '<span class="pct" style="color:'+(pct>=70?'var(--orange)':'var(--text)')+'">'+pct+'%</span>'+
      '</div>'+
      '<div class="bar"><div class="fill'+warn+'" style="width:'+Math.min(100,pct)+'%"></div></div>'+
      '<div class="r2"><span class="status">'+statusTxt+'</span><span>·</span><span class="act">'+act+'</span><span class="ago">'+ago(s.updatedMs)+' ago</span></div>'+
    '</div>';
  }).join('');
}
var failed=0;
function poll(){
  fetch('/api/sessions').then(function(r){return r.json();}).then(function(d){
    failed=0; render(d);
    document.getElementById('foot').textContent='live · refreshing every 3s';
  }).catch(function(){
    failed++;
    document.getElementById('foot').innerHTML='<span class="off">disconnected — server stopped?</span>';
  });
}
poll();
setInterval(poll,3000);
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith('/api/sessions')) {
    let data;
    try {
      data = scanSessions(config);
    } catch (e) {
      console.error('[dashboard] scan failed:', e.message);
      data = { error: true, sessions: [], totals: { shown: 0, active: 0 }, maxSessions: config.maxSessions };
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(data));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderPage());
});

if (require.main === module) {
  server.listen(config.port, () => {
    const url = `http://localhost:${config.port}`;
    console.log(`\n  ⚡ Claude Sessions dashboard → ${url}`);
    console.log(`     top ${config.maxSessions} · active < ${config.activeWindowMin}m · lookback ${config.lookbackHours}h\n`);
    try {
      const p = process.platform;
      if (p === 'darwin') spawn('open', [url], { stdio: 'ignore' });
      else if (p === 'win32') spawn('cmd', ['/c', 'start', url], { stdio: 'ignore' });
      else spawn('xdg-open', [url], { stdio: 'ignore' });
    } catch { /* best-effort */ }
  });
}

module.exports = { renderPage, server, config };
