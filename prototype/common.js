// ===== 共用假資料與工具（原型用） =====

// ===== 設定檔：直接讀正式版的 YAML（只要改 YAML，不用改這裡） =====
// 瀏覽器不允許 file:// 讀本機檔案，所以原型要透過本機伺服器開啟（見 CLAUDE.md 第 12 節）
const CONFIG_DIR = '../defect-labeler/backend/config/';
const CONFIG_ERRORS = [];
function loadYaml(file) {
  try {
    const x = new XMLHttpRequest();
    x.open('GET', CONFIG_DIR + file + '?t=' + Date.now(), false);   // 同步讀取：頁面一載入就要用到
    x.send();
    if (x.status !== 200) throw new Error('HTTP ' + x.status);
    return jsyaml.load(x.responseText);
  } catch (e) {
    CONFIG_ERRORS.push(`${file}：${location.protocol === 'file:' ? '無法以 file:// 讀取，請用本機伺服器開啟' : e.message}`);
    return null;
  }
}
const CFG_USERS = loadYaml('users.yaml') || {};
const CFG_CLASSES = loadYaml('classes.yaml') || {};

// ===== 使用者與權限（config/users.yaml） =====
// 身分由外部取得（不做登入、也不做選擇頁面）；YAML 只管理每個人有哪些權限
const ROLES = CFG_USERS.roles || {};
const USERS = (CFG_USERS.users || []).map(u => ({ ...u, id: String(u.id), name: String(u.name ?? u.id), active: u.active !== false }));
const userById = (id) => USERS.find(u => u.id === id) || null;
// 原型：模擬外部傳來的身分（正式版由後端從外部來源取得）
const EXTERNAL_USER_ID = 'weichun';
function currentUser() { const u = userById(EXTERNAL_USER_ID); return u && u.active ? u : null; }
function can(perm) { const u = currentUser(); return !!u && (ROLES[u.role] || []).includes(perm); }
function nowStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const LOT_RE = /^[A-Z0-9]{6}-[A-Z0-9]{2}-[A-Z0-9]{2}$/;

function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const f = (n) => { const k = (n + h / 30) % 12, c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}
// ===== 缺點類別（config/classes.yaml） =====
// class id 固定，永不重新排序；停用的保留位置。陣列索引 = id，所以 id 必須從 0 連續
const CLASSES = (() => {
  const list = (CFG_CLASSES.classes || []).map(c => ({
    id: +c.id, name: String(c.name), display: String(c.display ?? c.name),
    color: c.color || hslHex((+c.id * 137.5) % 360, 62, 50), active: c.active !== false,
  })).sort((a, b) => a.id - b.id);
  list.forEach((c, i) => { if (c.id !== i) CONFIG_ERRORS.push(`classes.yaml：id 必須從 0 連續且不重複（第 ${i + 1} 筆是 ${c.id}）`); });
  if (CFG_CLASSES.classes && !list.length) CONFIG_ERRORS.push('classes.yaml：沒有任何類別');
  return list;
})();
for (const u of USERS) if (!ROLES[u.role]) CONFIG_ERRORS.push(`users.yaml：${u.id} 的角色「${u.role}」沒有定義在 roles`);

// 設定檔有問題時整頁顯示錯誤（其他頁面腳本可能因此出錯，以這個訊息為準）
if (CONFIG_ERRORS.length) {
  console.error('設定檔錯誤', CONFIG_ERRORS);
  addEventListener('DOMContentLoaded', () => {
    document.body.innerHTML = `<div style="max-width:640px;margin:80px auto;padding:24px;font:15px/1.6 sans-serif;background:var(--surface);color:var(--text);border:1px solid var(--danger);border-radius:12px">
      <b style="color:var(--danger)">設定檔讀取失敗</b><ul>${CONFIG_ERRORS.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
      <div style="color:var(--muted);font-size:13px">請在 labelImg 資料夾執行 <code>python3 -m http.server 8000</code>，再開 <code>http://localhost:8000/prototype/</code></div></div>`;
  });
}
// 搜尋：中文名稱、英文代碼、id 都可以；開頭符合的排前面
function matchClass(c, q) {
  q = q.trim().toLowerCase();
  if (!q) return 1;
  const hay = [c.display.toLowerCase(), c.name.toLowerCase(), String(c.id)];
  if (hay.some(h => h.startsWith(q))) return 2;
  if (hay.some(h => h.includes(q))) return 1;
  return 0;
}
function hilite(text, q) {
  q = q.trim(); if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  return i < 0 ? esc(text) : esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

const STATUS = {
  unassigned:  { label: '未分配',   cls: 'b-gray' },
  in_progress: { label: '標註中',   cls: 'b-blue' },
  submitted:   { label: '已送審',   cls: 'b-purple' },
  approved:    { label: '已核准',   cls: 'b-green' },
  rejected:    { label: '已退回',   cls: 'b-red' },
  reopened:    { label: '重新開啟', cls: 'b-orange' },
};
const VERDICT = {
  NG:      { label: 'NG',     cls: 'b-red' },
  OK:      { label: 'OK',     cls: 'b-green' },
  none:    { label: '未判定', cls: 'b-gray' },
};

const LOTS = {
  '202611-01-03': { count: 12483, status: 'in_progress', product: 'PCB-A12', station: 'AOI-03',
                    source: 'Redis 快取', done: 7210, ok: 4630, ng: 2580, online: 3,
                    width: 300, height: 300 },
  '202611-02-01': { count: 8640, status: 'new', product: 'PCB-A12', station: 'AOI-05',
                    source: 'MongoDB（已回填快取）', width: 300, height: 300 },
};

function readOpened() {
  try { return JSON.parse(localStorage.getItem('dl_opened') || '{}'); } catch { return {}; }
}
function markOpened(lot) {
  const o = readOpened(); o[lot] = true;
  try { localStorage.setItem('dl_opened', JSON.stringify(o)); } catch {}
}
function getLot(lot) {
  const d = LOTS[lot];
  if (!d) return null;
  if (d.status === 'new' && readOpened()[lot])
    return { ...d, status: 'open', done: 0, ok: 0, ng: 0, online: 1 };
  return { ...d };
}

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let _toastTimer;
function toast(t) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = t; el.classList.add('show');
  clearTimeout(_toastTimer); _toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// 決定性亂數（同一個 Lot 每次產生一樣的假資料）
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

// ===== 共用頂部列 =====
function renderHeader() {
  const h = document.querySelector('header.app');
  h.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px">
      <a class="brand" href="index.html"><div class="brand-mark"></div>Defect Labeler</a>
      <span class="project-title">AVI</span>
    </div>
    <div class="user">
      <button class="icon-btn" id="themeBtn" title="切換深淺色">◐</button>
      ${(() => { const u = currentUser();
        return u ? `<span class="uname">${esc(u.name)}</span><span class="avatar">${esc(u.name[0].toUpperCase())}</span>`
                 : '<span class="uname">無權限</span><span class="avatar">?</span>'; })()}
    </div>`;
  try { const t = localStorage.getItem('dl_theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
  $('themeBtn').onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('dl_theme', root.dataset.theme); } catch {}
  };
}

// ===== AI vs 人工比對 =====
const AI_CMP = {
  escape:   { label: '逃漏',     color: 'var(--danger)', tip: 'AI 判 OK，人工判 NG' },
  overkill: { label: '過殺',     color: 'var(--warn)',   tip: 'AI 判缺點，人工判 OK' },
  mismatch: { label: '類別不符', color: 'var(--purple)', tip: 'AI 與人工都判 NG，但類別不同' },
};
const aiLabel = (ai) => ai === 'OK' ? 'OK' : CLASSES[+ai].display;
// 以人工判定為準：逃漏（AI OK、人工 NG）、過殺（AI 判缺點、人工 OK）、類別不符（都 NG 但類別不同）
function computeAiCmp(verdict, ai, defects) {
  if (verdict === 'NG' && ai === 'OK') return 'escape';
  if (verdict === 'OK' && ai !== 'OK') return 'overkill';
  if (verdict === 'NG' && !defects.some(d => d.class_id === +ai)) return 'mismatch';
  return '';
}

// ===== 篩選（清單頁與標註頁共用，確保上一張／下一張只在篩選結果內） =====
const FILTER_KEYS = ['verdict', 'class_id', 'ai', 'ai_cmp'];
const FACETS = {
  verdict:  { opts: Object.keys(VERDICT).map(k => ({ v: k, label: VERDICT[k].label })), test: (it, v) => it.verdict === v },
  class_id: { opts: CLASSES.map(c => ({ v: String(c.id), label: c.display, color: c.color, inactive: !c.active })),
              test: (it, v) => it.classes.has(+v) },
  ai:       { opts: [{ v: 'OK', label: 'OK' }, ...CLASSES.map(c => ({ v: String(c.id), label: c.display, color: c.color, inactive: !c.active }))],
              test: (it, v) => it.ai === v },
  ai_cmp:   { opts: Object.keys(AI_CMP).map(k => ({ v: k, label: AI_CMP[k].label, color: AI_CMP[k].color })), test: (it, v) => it.aiCmp === v },
};
function matchFilters(it, filters, skip) {
  return FILTER_KEYS.every(k => k === skip || !filters[k] || FACETS[k].test(it, filters[k]));
}
function readFilters(params) {
  const f = {}; for (const k of FILTER_KEYS) f[k] = params.get(k) || ''; return f;
}

// ===== 原型用的儲存（存在瀏覽器，模擬後端） =====
// bbox 一律以原圖像素 {x, y, w, h} 記錄（左上角＋寬高）
const EDITS_KEY = 'dl_edits_v2';
function readEdits() { try { return JSON.parse(localStorage.getItem(EDITS_KEY) || '{}'); } catch { return {}; } }
function saveEdit(id, data) {
  const e = readEdits(); e[id] = data;
  try { localStorage.setItem(EDITS_KEY, JSON.stringify(e)); } catch {}
}
// 儲存時有框就是 NG，沒框就是 OK；尚未儲存過為 none
function computeVerdict(defects) { return defects.length ? 'NG' : 'OK'; }
function finalizeItem(it) {
  it.classes = new Set(it.defects.map(d => d.class_id));
  it.aiCmp = computeAiCmp(it.verdict, it.ai, it.defects);
  return it;
}

// ===== 產生 Lot 的假標註資料 =====
const LOCKERS = ['Ben', 'Amy', 'Chris', 'Dana'];
const LABELERS = ['Amy', 'Ben', 'Chris', 'Dana', 'Eric'];
const CLASS_W = (() => {
  const head = [0.28, 0.16, 0.14, 0.09, 0.09, 0.01, 0.11];
  const rest = (1 - head.reduce((a, b) => a + b, 0)) / (CLASSES.length - head.length);
  return CLASSES.map((c, i) => i < head.length ? head[i] : rest);
})();
const STATIONS_T = ['2026-11-10 08:', '2026-11-10 14:', '2026-11-11 09:'];
function genItems(LOT, lot) {
  const W = lot.width, H = lot.height;
  const rng = mulberry32(hashStr(LOT));
  const n = lot.count;
  const v = new Array(n).fill(null);
  let k = 0;
  for (let i = 0; i < lot.ng; i++) v[k++] = 'NG';
  for (let i = 0; i < lot.ok; i++) v[k++] = 'OK';
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [v[i], v[j]] = [v[j], v[i]]; }

  const pickClass = () => { let r = rng(), a = 0; for (let i = 0; i < CLASS_W.length; i++) { a += CLASS_W[i]; if (r < a) return i; } return 0; };
  const mkDefect = () => {
    const w = Math.round(4 + rng() ** 2 * 70), h = Math.round(4 + rng() ** 2 * 60);
    const x = Math.round(rng() * (W - w)), y = Math.round(rng() * (H - h));
    return { class_id: pickClass(), bbox: { x, y, w, h }, attributes: {} };
  };
  const edits = readEdits();
  return v.map((verdict, i) => {
    let status, defects = [];
    if (!verdict) status = rng() < 0.006 ? 'in_progress' : 'unassigned';
    else {
      const r = rng();
      status = r < 0.42 ? 'submitted' : r < 0.84 ? 'approved' : r < 0.91 ? 'in_progress' : r < 0.96 ? 'rejected' : 'reopened';
    }
    if (verdict === 'NG') { const c = 1 + Math.floor(rng() ** 2 * 4); for (let j = 0; j < c; j++) defects.push(mkDefect()); }
    let ai;
    if (verdict === 'NG') ai = rng() < 0.82 ? String(defects[0].class_id) : rng() < 0.5 ? 'OK' : String(pickClass());
    else if (verdict === 'OK') ai = rng() < 0.9 ? 'OK' : String(pickClass());
    else ai = rng() < 0.62 ? 'OK' : String(pickClass());
    const aiScore = +(0.5 + rng() * 0.49).toFixed(2);
    const id = 'a' + (100000 + i);
    const captured = STATIONS_T[i % 3] + String(10 + i % 50).padStart(2, '0');
    const annotator = LABELERS[i % LABELERS.length];
    const annotatedAt = `2026-11-${String(10 + i % 2).padStart(2, '0')} ${String(9 + i % 9).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:${String((i * 7) % 60).padStart(2, '0')}`;
    defects.forEach((d, j) => { d.id = `${id}-d${j}`; });
    // 少數圖之後被別人修改過
    const modified = verdict && i % 7 === 0;
    const it = {
      id, idx: i + 1, ai, aiScore,
      filename: `IMG_${String(i + 1).padStart(5, '0')}.png`,
      path: `/data/${LOT}/IMG_${String(i + 1).padStart(5, '0')}.png`,
      verdict: verdict || 'none', status, defects,
      version: verdict ? 2 + (i % 4) : 1,
      captured,
      // 整張圖只記一組：最後一次修改（儲存）的人員與時間，每次儲存覆寫
      updated_by: !verdict ? null : modified ? LABELERS[(i + 2) % LABELERS.length] : annotator,
      updated_at: !verdict ? null : modified ? `2026-11-12 ${String(8 + i % 4).padStart(2, '0')}:${String((i * 3) % 60).padStart(2, '0')}:00` : annotatedAt,
      thumb: Math.floor(rng() * 6),
      lockedBy: status === 'in_progress' && rng() < 0.5 ? LOCKERS[Math.floor(rng() * LOCKERS.length)] : null,
    };
    const e = edits[id];
    if (e) Object.assign(it, { defects: e.defects, verdict: e.verdict, version: e.version, status: e.status,
                               updated_by: e.updated_by || e.annotated_by, updated_at: e.updated_at || e.annotated_at });
    return finalizeItem(it);
  });
}

// ===== 假圖片（PCB 風格），同一個 t 不論大小畫出相同圖案 =====
function makePcbCanvas(t, w, h) {
  const rng = mulberry32(t * 7919 + 13);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.scale(w / 320, h / 240);
  g.fillStyle = `hsl(${148 + t * 3}, ${38 + t * 3}%, ${17 + (t % 3) * 3}%)`; g.fillRect(0, 0, 320, 240);
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(255,255,255,${rng() * 0.04})`; g.fillRect(rng() * 320, rng() * 240, 2, 2); }
  g.strokeStyle = 'rgba(205,170,90,.75)'; g.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    g.lineWidth = 1.5 + rng() * 2.5; g.beginPath();
    let x = rng() * 320, y = rng() * 240; g.moveTo(x, y);
    for (let s = 0; s < 3; s++) { if (rng() < .5) x = rng() * 320; else y = rng() * 240; g.lineTo(x, y); }
    g.stroke();
  }
  g.fillStyle = 'rgba(215,190,120,.9)';
  for (let i = 0; i < 26; i++) { g.beginPath(); g.arc(rng() * 320, rng() * 240, 2 + rng() * 3, 0, 7); g.fill(); }
  for (let i = 0; i < 3; i++) {
    const x = 20 + rng() * 240, y = 20 + rng() * 170, bw = 30 + rng() * 50, bh = 20 + rng() * 30;
    g.fillStyle = '#c9c9c9'; for (let p = 0; p < bw; p += 6) { g.fillRect(x + p, y - 4, 3, 4); g.fillRect(x + p, y + bh, 3, 4); }
    g.fillStyle = '#1b1b1d'; g.fillRect(x, y, bw, bh);
  }
  // 細微紋理，讓放大時有東西可看
  if (w > 1000) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < 6000; i++) { g.fillStyle = `rgba(0,0,0,${rng() * 0.12})`; g.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2); }
  }
  return c;
}
function makeThumbs() {
  const out = [];
  for (let t = 0; t < 6; t++) out.push(makePcbCanvas(t, 300, 300).toDataURL('image/png'));
  return out;
}

// ===== 類別搜尋選單（輸入後顯示可點選的建議） =====
// opts: { placeholder, items: () => [{v, label, sub, color, count, inactive}], onPick(v), recent: [v], query matching via matchClass-like fn }
function mountCombo(host, opts) {
  host.classList.add('combo');
  host.innerHTML = `<input type="text" class="combo-in" placeholder="${esc(opts.placeholder || '輸入搜尋…')}" autocomplete="off" spellcheck="false">
    <div class="combo-list" hidden></div>`;
  const input = host.querySelector('input'), list = host.querySelector('.combo-list');
  let act = 0, shown = [];
  const score = (it, q) => {
    q = q.trim().toLowerCase(); if (!q) return 1;
    const hay = [it.label, it.sub || '', String(it.v)].map(x => x.toLowerCase());
    return hay.some(h => h.startsWith(q)) ? 2 : hay.some(h => h.includes(q)) ? 1 : 0;
  };
  function render() {
    const q = input.value;
    const all = opts.items();
    if (!q.trim() && opts.recent && opts.recent().length) {
      const rec = opts.recent().map(v => all.find(x => x.v === v)).filter(Boolean);
      shown = [...rec.map(x => ({ ...x, _recent: true })), ...all.filter(x => !rec.includes(x))];
    } else {
      shown = all.map(x => ({ x, s: score(x, q) })).filter(o => o.s > 0)
        .sort((a, b) => b.s - a.s || (b.x.count ?? 0) - (a.x.count ?? 0)).map(o => o.x);
    }
    act = Math.min(act, Math.max(0, shown.length - 1));
    list.innerHTML = shown.length ? shown.map((it, i) => `
      <div class="combo-item ${i === act ? 'act' : ''} ${it.inactive ? 'inactive' : ''}" data-i="${i}">
        ${it.color ? `<span class="sw" style="background:${it.color}"></span>` : ''}
        <span class="lb">${hilite(it.label, q)}${it.inactive ? '<span class="muted">（停用）</span>' : ''}</span>
        ${it.sub ? `<span class="sub mono">${hilite(it.sub, q)}</span>` : ''}
        ${it._recent && (i === 0 || !shown[i - 1]._recent) ? '<span class="tag">最近使用</span>' : ''}
        ${it.count != null ? `<span class="cnt">${fmt(it.count)}</span>` : ''}
      </div>`).join('') : `<div class="combo-empty">找不到「${esc(q)}」</div>`;
    list.hidden = false;
    list.querySelector('.act')?.scrollIntoView({ block: 'nearest' });
  }
  function pick(i) {
    const it = shown[i]; if (!it) return;
    input.value = ''; list.hidden = true; input.blur();
    opts.onPick(it.v);
  }
  input.addEventListener('focus', () => { act = 0; render(); });
  input.addEventListener('input', () => { act = 0; render(); });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); act = Math.min(shown.length - 1, act + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); act = Math.max(0, act - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(act); }
    else if (e.key === 'Escape') { input.value = ''; list.hidden = true; input.blur(); }
    e.stopPropagation();
  });
  list.addEventListener('mousedown', (e) => { const el = e.target.closest('.combo-item'); if (el) { e.preventDefault(); pick(+el.dataset.i); } });
  list.addEventListener('mousemove', (e) => { const el = e.target.closest('.combo-item'); if (el && +el.dataset.i !== act) { act = +el.dataset.i; list.querySelectorAll('.combo-item').forEach((n, i) => n.classList.toggle('act', i === act)); } });
  return input;
}
