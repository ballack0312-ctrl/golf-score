'use strict';

/* =========================================================
 * ゴルフスコア管理アプリ
 * データはブラウザの localStorage に保存する。
 *   round  = { id, date, course, memo, start, pars[18],
 *              player, strokes[18], putts[18],          … 先頭プレーヤー
 *              companions: [{ name, strokes[18], putts[18] }] }  … 同伴者
 *   course = { pars[18] }  … コースごとのパー設定を記憶
 * 過去の記録（ベスト・ワースト・成績・推移）はすべて先頭プレーヤーのスコアで計算する。
 * ========================================================= */

const STORAGE_KEY = 'golf-score-app/v1';
const DRAFT_KEY = 'golf-score-app/draft';
const HOLES = 18;
const DEFAULT_PAR = 4;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let data = loadData();
let editingId = null;   // 編集中のラウンドID
let detailId = null;    // 詳細表示中のラウンドID

const MAX_PLAYERS = 4;
let players = [];       // 入力中のプレーヤー [{ name, strokes[18], putts[18] }]（0番目が先頭プレーヤー）
let cur = 0;            // 入力表に表示中のプレーヤー

/* ---------- 保存・読み込み ---------- */

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.rounds)) {
        return { rounds: d.rounds.filter(isValidRound), courses: d.courses || {} };
      }
    }
  } catch (e) {
    console.warn('データの読み込みに失敗しました', e);
  }
  return { rounds: [], courses: {} };
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    toast('保存に失敗しました（ブラウザの保存領域が使えません）');
    return false;
  }
}

function isValidRound(r) {
  return r && typeof r.id === 'string' && typeof r.date === 'string' && typeof r.course === 'string'
    && Array.isArray(r.pars) && r.pars.length === HOLES
    && Array.isArray(r.strokes) && r.strokes.length === HOLES
    && r.strokes.every(n => Number.isInteger(n) && n > 0);
}

/* ---------- ユーティリティ ---------- */

const sum = arr => arr.reduce((s, v) => s + (Number(v) || 0), 0);
const toInt = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtDiff = n => (n === 0 ? '±0' : n > 0 ? `+${n}` : String(n));
const fmtDate = s => s.replace(/-/g, '/');
const avg = arr => (arr.length ? sum(arr) / arr.length : null);
const fix1 = n => (n == null ? '-' : n.toFixed(1));

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

/** パットが全ホール入力済みならその合計、未入力があれば null */
function puttTotal(r) {
  if (!Array.isArray(r.putts) || r.putts.some(p => p == null)) return null;
  return sum(r.putts);
}

/** 1ホールの結果ラベル */
function resultOf(strokes, par) {
  if (!strokes) return null;
  const d = strokes - par;
  if (strokes === 1) return { label: 'ホールインワン', cls: 'r-eagle' };
  if (d <= -3) return { label: 'アルバトロス', cls: 'r-eagle' };
  if (d === -2) return { label: 'イーグル', cls: 'r-eagle' };
  if (d === -1) return { label: 'バーディー', cls: 'r-birdie' };
  if (d === 0) return { label: 'パー', cls: 'r-par' };
  if (d === 1) return { label: 'ボギー', cls: 'r-bogey' };
  if (d === 2) return { label: 'ダブルボギー', cls: 'r-double' };
  return { label: fmtDiff(d), cls: 'r-triple' };
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

/* =========================================================
 * タブ切り替え
 * ========================================================= */

function showView(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') renderHistory();
  if (name === 'stats') renderStats();
  window.scrollTo(0, 0);
}

$$('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));

/* =========================================================
 * スコア入力
 * ========================================================= */

const form = $('#round-form');
const rowsEl = $('#hole-rows');

/** タップで入力できる結果マーク（ダブルボギーまで） */
const MARKS = [
  { diff: -2, sym: '◎', label: 'イーグル' },
  { diff: -1, sym: '○', label: 'バーディー' },
  { diff: 0, sym: '−', label: 'パー' },
  { diff: 1, sym: '△', label: 'ボギー' },
  { diff: 2, sym: '□', label: 'ダブルボギー' },
];

function subtotalRow(key, label) {
  return `<tr class="subtotal ${key}"><th>${label}</th><td class="s-par"></td><td class="s-diff"></td><td class="s-strokes"></td><td class="s-putts"></td></tr>`;
}

function buildRows() {
  let html = '';
  for (let i = 0; i < HOLES; i++) {
    const n = i + 1;
    const opts = [3, 4, 5, 6].map(p => `<option value="${p}"${p === DEFAULT_PAR ? ' selected' : ''}>${p}</option>`).join('');
    const marks = MARKS.map(m =>
      `<button type="button" class="mark" data-diff="${m.diff}" title="${m.label}" aria-label="${n}番ホール ${m.label}" aria-pressed="false">${m.sym}</button>`).join('');
    html += `<tr data-hole="${i}" class="${n % 2 ? 'hole-odd' : 'hole-even'}">
      <td class="hole-no"><button type="button" class="hole-btn" aria-label="${n}番ホールの過去の記録">${n}</button></td>
      <td><select class="par" aria-label="${n}番ホール パー">${opts}</select></td>
      <td class="marks"><div class="mark-group"><div class="mark-row">${marks}</div><span class="over"></span></div><div class="ref"></div></td>
      <td><input class="strokes" type="number" inputmode="numeric" min="1" max="20" aria-label="${n}番ホール 打数"></td>
      <td><input class="putts" type="number" inputmode="numeric" min="0" max="10" aria-label="${n}番ホール パット"></td>
    </tr>`;
    if (i === 8) html += subtotalRow('out', 'OUT');
  }
  html += subtotalRow('in', 'IN') + subtotalRow('total', 'TOTAL');
  rowsEl.innerHTML = html;
}

/** ホール行（表示順ではなく 1番〜18番 の順） */
function holeRows() {
  return $$('tr[data-hole]', rowsEl).sort((a, b) => a.dataset.hole - b.dataset.hole);
}

/* ---------- OUT / IN スタート ---------- */

function getStart() {
  return $('input[name="start"]:checked')?.value === 'in' ? 'in' : 'out';
}

/** 入力表の並びをスタートに合わせて入れ替える（自動で次へ進む順もこれに従う） */
function applyStart(start) {
  const rows = holeRows();
  const out = rows.slice(0, 9), inn = rows.slice(9);
  const [outSub, inSub, total] = ['out', 'in', 'total'].map(k => $(`tr.subtotal.${k}`, rowsEl));
  const order = start === 'in'
    ? [...inn, inSub, ...out, outSub, total]
    : [...out, outSub, ...inn, inSub, total];
  order.forEach(tr => rowsEl.appendChild(tr));
}

function setStart(start) {
  const v = start === 'in' ? 'in' : 'out';
  $(`input[name="start"][value="${v}"]`).checked = true;
  applyStart(v);
}

/* ---------- プレーヤー（自分 + 同伴者） ---------- */

function emptyHoles() { return Array(HOLES).fill(null); }
function newPlayer(name) { return { name, strokes: emptyHoles(), putts: emptyHoles() }; }

/** 先頭プレーヤーの初期名：前回のラウンドの名前、なければ「自分」 */
function defaultSelfName() {
  return sortedRounds()[0]?.player || '自分';
}

function playerLabel(k) {
  const n = (players[k]?.name || '').trim();
  return n || (k === 0 ? '自分' : `同伴者${k}`);
}

/** ラウンド（または下書き）からプレーヤー配列を作る */
function roundPlayers(r) {
  const holes = a => (Array.isArray(a) && a.length === HOLES ? [...a] : emptyHoles());
  if (Array.isArray(r.players) && r.players.length) {
    return r.players.slice(0, MAX_PLAYERS).map(p => ({ name: p.name || '', strokes: holes(p.strokes), putts: holes(p.putts) }));
  }
  return [
    { name: r.player || '自分', strokes: holes(r.strokes), putts: holes(r.putts) },
    ...(r.companions || []).map(c => ({ name: c.name || '', strokes: holes(c.strokes), putts: holes(c.putts) })),
  ].slice(0, MAX_PLAYERS);
}

/** 入力表の内容を、表示中のプレーヤーに書き戻す */
function syncCurrentPlayer() {
  if (!players[cur]) return;
  const { strokes, putts } = readHoles();
  players[cur].strokes = strokes;
  players[cur].putts = putts;
}

function switchPlayer(k) {
  if (k === cur || !players[k]) return;
  syncCurrentPlayer();
  cur = k;
  writeHoles({ strokes: players[cur].strokes, putts: players[cur].putts });
  renderPlayerList();
  updateTotals();
  saveDraft();
}

/** プレーヤー欄（名前の入力） */
function renderPlayerList() {
  $('#player-list').innerHTML = players.map((p, k) => `
    <div class="player-row${k === cur ? ' current' : ''}" data-idx="${k}">
      <span class="p-no">${k + 1}</span>
      <input class="p-name" type="text" value="${esc(p.name)}" placeholder="${k === 0 ? '自分' : `同伴者${k}`}"
        ${k ? 'list="companion-list"' : ''} autocomplete="off" aria-label="${k + 1}人目の名前">
      ${k === 0
        ? '<span class="p-tag" title="過去の記録・成績にはこのプレーヤーのスコアを使います">先頭</span>'
        : `<button type="button" class="p-remove" aria-label="${esc(playerLabel(k))}を削除">削除</button>`}
    </div>`).join('');
  $('#btn-add-player').disabled = players.length >= MAX_PLAYERS;
}

/** 合計バーのプレーヤー切り替えボタン（名前とスコア） */
function renderPlayerChips() {
  const el = $('#player-switch');
  el.hidden = players.length < 2;
  if (el.hidden) { el.innerHTML = ''; return; }
  const pars = readHoles().pars;
  el.innerHTML = players.map((p, k) => {
    const played = p.strokes.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
    const score = played.length
      ? `${sum(p.strokes)}<small>${fmtDiff(sum(p.strokes) - sum(played.map(i => pars[i])))}</small>`
      : '<small>未入力</small>';
    return `<button type="button" class="p-chip${k === cur ? ' active' : ''}" data-idx="${k}" aria-pressed="${k === cur}">
      <span class="p-chip-name">${esc(playerLabel(k))}</span><span class="p-chip-score">${score}</span></button>`;
  }).join('');
}

$('#player-list').addEventListener('input', e => {
  if (!e.target.matches('.p-name')) return;
  const k = Number(e.target.closest('.player-row').dataset.idx);
  players[k].name = e.target.value;
  renderPlayerChips();
  updateSummary();
  saveDraft();
});

$('#player-list').addEventListener('focusin', e => {
  // 名前欄をタップしたら、そのプレーヤーの入力に切り替える
  if (!e.target.matches('.p-name')) return;
  const k = Number(e.target.closest('.player-row').dataset.idx);
  if (k !== cur) {
    syncCurrentPlayer();
    cur = k;
    writeHoles({ strokes: players[cur].strokes, putts: players[cur].putts });
    $$('.player-row').forEach(r => r.classList.toggle('current', Number(r.dataset.idx) === cur));
    updateTotals();
    saveDraft();
  }
});

$('#player-list').addEventListener('click', e => {
  const btn = e.target.closest('.p-remove');
  if (!btn) return;
  const k = Number(btn.closest('.player-row').dataset.idx);
  syncCurrentPlayer();
  const p = players[k];
  const hasScore = p.strokes.some(Boolean) || p.putts.some(v => v != null);
  if (hasScore && !confirm(`${playerLabel(k)} のスコアも削除されます。よろしいですか？`)) return;
  players.splice(k, 1);
  if (cur === k) cur = 0; else if (cur > k) cur--;
  writeHoles({ strokes: players[cur].strokes, putts: players[cur].putts });
  renderPlayerList();
  updateTotals();
  saveDraft();
});

$('#btn-add-player').addEventListener('click', () => {
  if (players.length >= MAX_PLAYERS) { toast(`プレーヤーは${MAX_PLAYERS}人までです`); return; }
  syncCurrentPlayer();
  players.push(newPlayer(''));
  cur = players.length - 1;
  writeHoles({ strokes: players[cur].strokes, putts: players[cur].putts });
  renderPlayerList();
  updateTotals();
  saveDraft();
  $(`.player-row[data-idx="${cur}"] .p-name`).focus();
});

$('#player-switch').addEventListener('click', e => {
  const chip = e.target.closest('.p-chip');
  if (chip) switchPlayer(Number(chip.dataset.idx));
});

/** 同伴者名の候補（過去の履歴から、よく一緒に回る順） */
function refreshNameList() {
  const count = new Map();
  for (const r of data.rounds) {
    for (const c of r.companions || []) {
      if (c.name) count.set(c.name, (count.get(c.name) || 0) + 1);
    }
  }
  $('#companion-list').innerHTML = [...count.entries()].sort((a, b) => b[1] - a[1])
    .map(([n]) => `<option value="${esc(n)}"></option>`).join('');
}

function readHoles() {
  const rows = holeRows();
  return {
    pars: rows.map(r => Number($('.par', r).value)),
    strokes: rows.map(r => toInt($('.strokes', r).value)),
    putts: rows.map(r => toInt($('.putts', r).value)),
  };
}

function writeHoles({ pars, strokes, putts }) {
  holeRows().forEach((r, i) => {
    if (pars) $('.par', r).value = pars[i] ?? DEFAULT_PAR;
    if (strokes) $('.strokes', r).value = strokes[i] ?? '';
    if (putts) $('.putts', r).value = putts[i] ?? '';
  });
}

/** 合計・結果表示を更新 */
function updateTotals() {
  syncCurrentPlayer();
  const { pars, strokes, putts } = readHoles();

  holeRows().forEach((r, i) => {
    const d = strokes[i] ? strokes[i] - pars[i] : null;
    let matched = false;
    $$('.mark', r).forEach(b => {
      const on = d !== null && Number(b.dataset.diff) === d;
      matched ||= on;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on);
    });
    // マークにない結果（トリプル以上・アルバトロス）とホールインワンは文字で表示
    const res = resultOf(strokes[i], pars[i]);
    const showText = res && (!matched || strokes[i] === 1);
    $('.over', r).innerHTML = showText ? `<span class="badge ${res.cls}">${res.label}</span>` : '';
    $('.strokes', r).classList.remove('invalid');
  });

  const ranges = { out: [0, 9], in: [9, 18], total: [0, 18] };
  for (const [key, [a, b]] of Object.entries(ranges)) {
    const row = $(`tr.subtotal.${key}`, rowsEl);
    const p = pars.slice(a, b), s = strokes.slice(a, b), pt = putts.slice(a, b);
    const played = s.map((v, i) => (v ? i : -1)).filter(i => i >= 0);
    $('.s-par', row).textContent = sum(p);
    $('.s-strokes', row).textContent = played.length ? sum(s) : '';
    $('.s-putts', row).textContent = pt.some(v => v != null) ? sum(pt) : '';
    $('.s-diff', row).textContent = played.length ? fmtDiff(sum(s) - sum(played.map(i => p[i]))) : '';
  }

  renderHoleRefs();
  renderPlayerChips();
  updateSummary();
}

/** 合計バーの文言（表示中のプレーヤー） */
function updateSummary() {
  const { pars, strokes, putts } = readHoles();
  const who = players.length > 1 ? `${playerLabel(cur)}：` : '';
  const playedCount = strokes.filter(Boolean).length;
  const summary = $('#summary-text');
  if (!playedCount) {
    summary.textContent = `${who}打数を入力してください`;
  } else {
    const parPlayed = sum(strokes.map((v, i) => (v ? pars[i] : 0)));
    const puttsText = putts.some(v => v != null) ? ` ・ パット ${sum(putts)}` : '';
    summary.textContent = `${who}スコア ${sum(strokes)}（${fmtDiff(sum(strokes) - parPlayed)}）${puttsText} ・ ${playedCount}/${HOLES}ホール`;
  }
}

/* ---------- 同じホールの過去の記録 ---------- */

/** 同じコースの過去ラウンド（新しい順・編集中のラウンドは除く） */
function pastRounds(course) {
  if (!course) return [];
  return sortedRounds(data.rounds.filter(r => r.course === course && r.id !== editingId));
}

function holeStats(rounds, i) {
  const s = rounds.map(r => r.strokes[i]);
  if (!s.length) return null;
  return { n: s.length, best: Math.min(...s), worst: Math.max(...s), avg: avg(s) };
}

/** 入力表の各ホールにベスト・ワースト・平均を表示 */
function renderHoleRefs() {
  const rounds = pastRounds($('#f-course').value.trim());
  holeRows().forEach((r, i) => {
    const st = holeStats(rounds, i);
    $('.ref', r).innerHTML = st
      ? `ベスト<b>${st.best}</b> ワースト<b>${st.worst}</b> 平均${st.avg.toFixed(1)}`
      : '';
    $('.hole-btn', r).classList.toggle('has-ref', !!st);
  });
}

const holeDialog = $('#hole-dialog');

/** ホール番号タップ → そのホールの過去の記録一覧 */
function openHoleHistory(i) {
  const course = $('#f-course').value.trim();
  if (!course) { toast('先にコース名を入力してください'); $('#f-course').focus(); return; }
  const rounds = pastRounds(course);
  if (!rounds.length) { toast(`「${course}」の過去の記録はまだありません`); return; }

  const st = holeStats(rounds, i);
  const par = Number($('.par', holeRows()[i]).value);
  const bestR = rounds.find(r => r.strokes[i] === st.best);
  const worstR = rounds.find(r => r.strokes[i] === st.worst);
  const putts = rounds.map(r => r.putts?.[i]).filter(v => v != null);

  const list = rounds.map(r => {
    const res = resultOf(r.strokes[i], r.pars[i]);
    return `<tr><td>${fmtDate(r.date)}</td><td class="num">${r.strokes[i]}</td>
      <td><span class="badge ${res.cls}">${res.label}</span></td><td class="num">${r.putts?.[i] ?? '-'}</td></tr>`;
  }).join('');

  $('#hole-body').innerHTML = `
    <div class="muted">${esc(course)}</div>
    <h2>${i + 1}番ホール（Par ${par}）</h2>
    <div class="hole-kpis">
      <div><div class="label">ベスト</div><div class="value">${st.best}</div><div class="note">${fmtDate(bestR.date)}</div></div>
      <div><div class="label">ワースト</div><div class="value">${st.worst}</div><div class="note">${fmtDate(worstR.date)}</div></div>
      <div><div class="label">平均</div><div class="value">${st.avg.toFixed(2)}</div><div class="note">${st.n}回</div></div>
      <div><div class="label">平均パット</div><div class="value">${putts.length ? avg(putts).toFixed(2) : '-'}</div><div class="note">${putts.length}回</div></div>
    </div>
    <div class="hole-list"><table>
      <thead><tr><th>日付</th><th>打数</th><th>結果</th><th>パット</th></tr></thead>
      <tbody>${list}</tbody>
    </table></div>`;
  holeDialog.showModal();
}

rowsEl.addEventListener('click', e => {
  const btn = e.target.closest('.hole-btn');
  if (btn) openHoleHistory(Number(btn.closest('tr[data-hole]').dataset.hole));
});
$('#btn-hole-close').addEventListener('click', () => holeDialog.close());

function resetForm() {
  editingId = null;
  form.reset();
  setStart('out');
  $('#f-date').value = today();
  players = [newPlayer(defaultSelfName())];
  cur = 0;
  writeHoles({ pars: Array(HOLES).fill(DEFAULT_PAR), strokes: [], putts: [] });
  renderPlayerList();
  $('#edit-banner').hidden = true;
  $('#btn-save').textContent = '保存';
  updateTotals();
  clearDraft();
}

function fillForm(round) {
  $('#f-date').value = round.date;
  $('#f-course').value = round.course;
  $('#f-memo').value = round.memo || '';
  setStart(round.start);
  players = roundPlayers(round);
  cur = Number.isInteger(round.cur) && players[round.cur] ? round.cur : 0;
  writeHoles({ pars: round.pars, strokes: players[cur].strokes, putts: players[cur].putts });
  renderPlayerList();
  updateTotals();
}

function startEdit(id) {
  const round = data.rounds.find(r => r.id === id);
  if (!round) return;
  fillForm(round);
  editingId = id;
  $('#edit-banner').hidden = false;
  $('#btn-save').textContent = '更新';
  renderHoleRefs();
  saveDraft();
  showView('entry');
}

/** 過去の履歴にあるコース一覧（最近プレーした順） */
function knownCourses() {
  const map = new Map();
  for (const r of data.rounds) {
    const c = map.get(r.course) || { name: r.course, count: 0, last: '' };
    c.count++;
    if (r.date > c.last) c.last = r.date;
    map.set(r.course, c);
  }
  // パー設定だけ記憶されているコース（ラウンドを削除した場合など）も候補に含める
  for (const name of Object.keys(data.courses)) {
    if (!map.has(name)) map.set(name, { name, count: 0, last: '' });
  }
  return [...map.values()].sort((a, b) => b.last.localeCompare(a.last) || a.name.localeCompare(b.name, 'ja'));
}

function refreshCourseList() {
  const courses = knownCourses();
  // 入力中の候補（datalist）
  $('#course-list').innerHTML = courses.map(c => `<option value="${esc(c.name)}"></option>`).join('');
  // 「履歴から選ぶ」プルダウン
  const pick = $('#f-course-pick');
  pick.hidden = !courses.length;
  pick.innerHTML = '<option value="">履歴から選ぶ</option>' + courses.map(c => {
    const info = c.count ? `${c.count}回・最終 ${fmtDate(c.last)}` : '記録なし';
    return `<option value="${esc(c.name)}">${esc(c.name)}（${info}）</option>`;
  }).join('');
}

// 履歴からコースを選ぶ → コース名を入れて、パー・過去の記録も自動反映
$('#f-course-pick').addEventListener('change', e => {
  const name = e.target.value;
  e.target.value = '';
  if (!name) return;
  const input = $('#f-course');
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

/* 下書き保存（ラウンド中にページを閉じても入力が消えないように） */
function saveDraft() {
  try {
    syncCurrentPlayer();
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      editingId,
      date: $('#f-date').value,
      course: $('#f-course').value,
      memo: $('#f-memo').value,
      start: getStart(),
      pars: readHoles().pars,
      players,
      cur,
    }));
  } catch (e) { /* 保存できなくても動作は続ける */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* noop */ }
}

function restoreDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (!d) return false;
    fillForm(d);
    if (d.editingId && data.rounds.some(r => r.id === d.editingId)) {
      editingId = d.editingId;
      $('#edit-banner').hidden = false;
      $('#btn-save').textContent = '更新';
      renderHoleRefs();
    }
    return true;
  } catch (e) {
    return false;
  }
}

rowsEl.addEventListener('input', () => { updateTotals(); saveDraft(); });

// 結果マークをタップ → 打数 = パー + 差 を入力（選択中のマークをもう一度タップで取り消し）
rowsEl.addEventListener('click', e => {
  const btn = e.target.closest('.mark');
  if (!btn) return;
  const row = btn.closest('tr[data-hole]');
  const input = $('.strokes', row);
  input.value = btn.classList.contains('active') ? '' : Number($('.par', row).value) + Number(btn.dataset.diff);
  updateTotals();
  saveDraft();
});
form.addEventListener('input', e => {
  if (rowsEl.contains(e.target) || e.target.closest('#player-list')) return;
  if (e.target.id === 'f-course') renderHoleRefs();
  if (e.target.name === 'start') applyStart(getStart());
  saveDraft();
});

// 打数を入れたら次の入力欄へ自動で進む（1桁入力時）
rowsEl.addEventListener('input', e => {
  const el = e.target;
  if (!el.matches('.strokes, .putts') || el.value.length !== 1) return;
  if (el.classList.contains('strokes') && el.value === '1') return; // 10打以上の可能性
  const inputs = $$('.strokes, .putts', rowsEl);
  const next = inputs[inputs.indexOf(el) + 1];
  if (next) next.focus();
});

/** コースのパー設定（記憶したもの → なければそのコースの最新ラウンドから） */
function coursePars(name) {
  const c = data.courses[name];
  if (c && Array.isArray(c.pars) && c.pars.length === HOLES) return c.pars;
  const latest = sortedRounds(data.rounds.filter(r => r.course === name))[0];
  return latest ? latest.pars : null;
}

/** 履歴にあるコース名と一致したら、パーを自動で入れる */
function autoLoadCoursePars() {
  if (editingId) return;
  const pars = coursePars($('#f-course').value.trim());
  if (!pars) return;
  const current = readHoles().pars;
  if (pars.every((p, i) => p === current[i])) return; // すでに同じなら何もしない
  writeHoles({ pars });
  updateTotals();
  saveDraft();
  toast('このコースのパーを自動で入力しました');
}

// 入力中（一覧から選んだ瞬間を含む）と、入力欄を離れたときの両方で判定
$('#f-course').addEventListener('input', autoLoadCoursePars);
$('#f-course').addEventListener('change', autoLoadCoursePars);

$('#btn-reset').addEventListener('click', () => {
  if (confirm('入力内容をクリアしますか？')) resetForm();
});

$('#btn-cancel-edit').addEventListener('click', resetForm);

form.addEventListener('submit', e => {
  e.preventDefault();
  const date = $('#f-date').value;
  const course = $('#f-course').value.trim();
  const memo = $('#f-memo').value.trim();
  syncCurrentPlayer();
  const { pars } = readHoles();

  if (!date) { toast('日付を入力してください'); $('#f-date').focus(); return; }
  if (!course) { toast('コース名を入力してください'); $('#f-course').focus(); return; }

  /** プレーヤー k のスコアを検証。問題があればそのプレーヤーに切り替えて知らせる */
  const validPlayer = k => {
    const { strokes, putts } = players[k];
    const who = players.length > 1 ? `${playerLabel(k)}：` : '';
    const missing = strokes.map((v, i) => (v && v > 0 ? -1 : i)).filter(i => i >= 0);
    if (missing.length) {
      switchPlayer(k);
      holeRows().forEach((r, i) => $('.strokes', r).classList.toggle('invalid', missing.includes(i)));
      toast(`${who}打数が未入力のホールがあります（${missing.map(i => i + 1).join(', ')}番）`);
      $('.strokes', holeRows()[missing[0]]).focus();
      return false;
    }
    const badPutt = putts.findIndex((p, i) => p != null && (p < 0 || p > strokes[i]));
    if (badPutt >= 0) {
      switchPlayer(k);
      toast(`${who}${badPutt + 1}番ホールのパット数が打数を超えています`);
      $('.putts', holeRows()[badPutt]).focus();
      return false;
    }
    return true;
  };

  // 先頭プレーヤーは全ホール必須。同伴者は何も入力していなければ保存しない
  if (!validPlayer(0)) return;
  const companions = [];
  for (let k = 1; k < players.length; k++) {
    const p = players[k];
    if (!p.strokes.some(Boolean) && !p.putts.some(v => v != null)) continue;
    if (!validPlayer(k)) return;
    companions.push({ name: playerLabel(k), strokes: [...p.strokes], putts: [...p.putts] });
  }

  const main = players[0];
  const strokes = [...main.strokes], putts = [...main.putts];
  const round = {
    id: editingId || newId(), date, course, memo, start: getStart(), pars,
    player: playerLabel(0), strokes, putts, companions,
  };
  const idx = data.rounds.findIndex(r => r.id === round.id);
  if (idx >= 0) data.rounds[idx] = round; else data.rounds.push(round);
  data.courses[course] = { pars };

  if (!saveData()) return;
  toast(idx >= 0 ? '記録を更新しました' : `保存しました：${sum(strokes)}（${fmtDiff(sum(strokes) - sum(pars))}）`);
  refreshCourseList();
  refreshNameList();
  resetForm();
  showView('history');
});

/* =========================================================
 * 履歴
 * ========================================================= */

function sortedRounds(rounds = data.rounds) {
  return [...rounds].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

function renderHistory() {
  const el = $('#history-list');
  const rounds = sortedRounds();
  if (!rounds.length) {
    el.innerHTML = '<div class="empty">まだ記録がありません。<br>「スコア入力」タブからラウンドを登録しましょう。</div>';
    return;
  }
  el.innerHTML = rounds.map(r => {
    const total = sum(r.strokes);
    const pt = puttTotal(r);
    const outS = `OUT ${sum(r.strokes.slice(0, 9))}`, inS = `IN ${sum(r.strokes.slice(9))}`;
    const halves = r.start === 'in' ? `${inS} / ${outS}` : `${outS} / ${inS}`;
    const comps = (r.companions || []).map(c => `${esc(c.name)} ${sum(c.strokes)}`).join(' ・ ');
    return `<button type="button" class="round-item" data-id="${esc(r.id)}">
      <span class="ri-date">${fmtDate(r.date)}${r.start === 'in' ? '<span class="start-badge">INスタート</span>' : ''}</span>
      <span class="ri-course">${esc(r.course)}</span>
      <span class="ri-sub">${halves}${pt != null ? ` ・ パット ${pt}` : ''}</span>
      ${comps ? `<span class="ri-sub ri-comp">同伴：${comps}</span>` : ''}
      <span class="ri-score"><strong>${total}</strong><span class="diff">${fmtDiff(total - sum(r.pars))}</span></span>
    </button>`;
  }).join('');
}

$('#history-list').addEventListener('click', e => {
  const item = e.target.closest('.round-item');
  if (item) openDetail(item.dataset.id);
});

/* ---------- 詳細ダイアログ ---------- */

const dialog = $('#detail-dialog');

function scorecardTable(r) {
  // プレーした順（INスタートなら IN → OUT）に並べる
  const segs = [[0, 9, 'OUT'], [9, 18, 'IN']];
  if (r.start === 'in') segs.reverse();
  const idx = (a, b) => [...Array(b - a)].map((_, k) => a + k);
  const row = (title, cell, subtotal, total, cls = '') =>
    `<tr class="${cls}"><th>${title}</th>${segs.map(([a, b]) =>
      idx(a, b).map(cell).join('') + `<td class="sub">${subtotal(a, b)}</td>`).join('')}<td class="sub">${total}</td></tr>`;
  const head = `<tr><th>H</th>${segs.map(([a, b, label]) =>
    idx(a, b).map(i => `<th>${i + 1}</th>`).join('') + `<th class="sub">${label}</th>`).join('')}<th class="sub">計</th></tr>`;

  // 先頭プレーヤー → 同伴者の順に、打数とパットの行を並べる
  const all = roundPlayers(r).filter(p => p.strokes.every(Boolean));
  const playerRows = all.map((p, k) => {
    const strokeCell = i => {
      const res = resultOf(p.strokes[i], r.pars[i]);
      return `<td><span class="cell ${res.cls}" title="${res.label}">${p.strokes[i]}</span></td>`;
    };
    const puttSum = (a, b) => {
      const v = p.putts.slice(a, b);
      return v.some(x => x != null) ? sum(v) : '-';
    };
    const name = all.length > 1 ? `<span class="pc-name">${esc(p.name || (k ? `同伴者${k}` : '自分'))}</span>` : '打数';
    let html = row(name, strokeCell, (a, b) => sum(p.strokes.slice(a, b)), sum(p.strokes), k ? 'pc-comp' : 'pc-main');
    if (p.putts.some(v => v != null)) {
      html += row('<span class="pc-putt">パット</span>', i => `<td>${p.putts[i] ?? '-'}</td>`, puttSum, puttSum(0, 18), 'pc-putts');
    }
    return html;
  }).join('');

  return `<div class="h-scroll"><table class="h-card">
    <thead>${head}</thead>
    <tbody>
      ${row('Par', i => `<td>${r.pars[i]}</td>`, (a, b) => sum(r.pars.slice(a, b)), sum(r.pars))}
      ${playerRows}
    </tbody>
  </table></div>`;
}

function openDetail(id) {
  const r = data.rounds.find(x => x.id === id);
  if (!r) return;
  detailId = id;
  const total = sum(r.strokes);
  $('#detail-body').innerHTML = `
    <div class="detail-head">
      <div>
        <div class="muted">${fmtDate(r.date)}${r.start === 'in' ? '<span class="start-badge">INスタート</span>' : ''}</div>
        <h2>${esc(r.course)}</h2>
      </div>
      <div class="detail-score">${total} <span class="diff">${fmtDiff(total - sum(r.pars))}</span></div>
    </div>
    ${scorecardTable(r)}
    ${r.memo ? `<p class="muted">メモ：${esc(r.memo)}</p>` : ''}`;
  dialog.showModal();
}

$('#btn-close').addEventListener('click', () => dialog.close());
$('#btn-edit').addEventListener('click', () => { dialog.close(); startEdit(detailId); });
$('#btn-delete').addEventListener('click', () => {
  const r = data.rounds.find(x => x.id === detailId);
  if (!r || !confirm(`${fmtDate(r.date)} ${r.course} の記録を削除しますか？`)) return;
  data.rounds = data.rounds.filter(x => x.id !== detailId);
  if (editingId === detailId) resetForm();
  saveData();
  dialog.close();
  renderHistory();
  refreshCourseList();
  renderHoleRefs();
  toast('削除しました');
});

/* =========================================================
 * 成績
 * ========================================================= */

const statsCourseSel = $('#stats-course');

function refreshStatsCourseOptions() {
  const current = statsCourseSel.value;
  const courses = [...new Set(data.rounds.map(r => r.course))].sort((a, b) => a.localeCompare(b, 'ja'));
  statsCourseSel.innerHTML = '<option value="">すべてのコース</option>' +
    courses.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  statsCourseSel.value = courses.includes(current) ? current : '';
}

statsCourseSel.addEventListener('change', renderStats);

function renderStats() {
  refreshStatsCourseOptions();
  const course = statsCourseSel.value;
  const rounds = data.rounds.filter(r => !course || r.course === course);
  const el = $('#stats');

  if (!rounds.length) {
    el.innerHTML = '<div class="empty">まだ記録がありません。<br>ラウンドを登録すると成績が表示されます。</div>';
    return;
  }

  const totals = rounds.map(r => sum(r.strokes));
  const bestIdx = totals.indexOf(Math.min(...totals));
  const best = rounds[bestIdx];
  const puttTotals = rounds.map(puttTotal).filter(v => v != null);

  // 直近5ラウンド平均
  const recent = sortedRounds(rounds).slice(0, 5).map(r => sum(r.strokes));

  // パー別平均 & 結果分布
  const byPar = { 3: [], 4: [], 5: [] };
  const dist = { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0, triple: 0 };
  let holeCount = 0;
  for (const r of rounds) {
    r.strokes.forEach((s, i) => {
      const p = r.pars[i];
      if (byPar[p]) byPar[p].push(s);
      const d = s - p;
      holeCount++;
      if (d <= -2) dist.eagle++;
      else if (d === -1) dist.birdie++;
      else if (d === 0) dist.par++;
      else if (d === 1) dist.bogey++;
      else if (d === 2) dist.double++;
      else dist.triple++;
    });
  }

  const distRows = [
    ['イーグル以上', dist.eagle, 'r-eagle'],
    ['バーディー', dist.birdie, 'r-birdie'],
    ['パー', dist.par, 'r-par-bar'],
    ['ボギー', dist.bogey, 'r-bogey'],
    ['ダブルボギー', dist.double, 'r-double'],
    ['トリプル以上', dist.triple, 'r-triple'],
  ];

  el.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="label">ラウンド数</div><div class="value">${rounds.length}</div></div>
      <div class="kpi"><div class="label">平均スコア</div><div class="value">${fix1(avg(totals))}</div>
        <div class="note">直近5R平均 ${fix1(avg(recent))}</div></div>
      <div class="kpi"><div class="label">ベストスコア</div><div class="value">${totals[bestIdx]}</div>
        <div class="note">${fmtDate(best.date)} ${esc(best.course)}</div></div>
      <div class="kpi"><div class="label">平均パット</div><div class="value">${fix1(avg(puttTotals))}</div>
        <div class="note">${puttTotals.length ? `1ホール ${(avg(puttTotals) / HOLES).toFixed(2)}` : 'パット未入力'}</div></div>
    </div>

    <div class="card">
      <h2>パー別の平均打数</h2>
      <div class="par-avgs">
        ${[3, 4, 5].map(p => `<div><div class="muted">Par ${p}</div><div class="value">${byPar[p].length ? (avg(byPar[p])).toFixed(2) : '-'}</div>
          <div class="muted">${byPar[p].length ? fmtDiff(+(avg(byPar[p]) - p).toFixed(2)) : ''}</div></div>`).join('')}
      </div>
    </div>

    <div class="card">
      <h2>ホールごとの結果（${holeCount}ホール）</h2>
      <div class="bars">
        ${distRows.map(([label, n, cls]) => {
          const pct = holeCount ? (n / holeCount) * 100 : 0;
          return `<div class="bar-row"><span>${label}</span>
            <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
            <span class="pct">${pct.toFixed(1)}%</span></div>`;
        }).join('')}
      </div>
    </div>

    <div class="card chart">
      <h2>スコア推移（直近20ラウンド）</h2>
      ${trendChart(sortedRounds(rounds).slice(0, 20).reverse())}
    </div>`;
}

/** スコア推移の折れ線グラフ（SVG） */
function trendChart(rounds) {
  if (rounds.length < 2) return '<p class="muted">2ラウンド以上記録すると推移グラフが表示されます。</p>';

  const W = 600, H = 220, PL = 40, PR = 16, PT = 14, PB = 30;
  const ys = rounds.map(r => sum(r.strokes));
  let min = Math.min(...ys), max = Math.max(...ys);
  min = Math.floor((min - 2) / 5) * 5;
  max = Math.ceil((max + 2) / 5) * 5;
  if (max - min < 10) max = min + 10;

  const x = i => PL + ((W - PL - PR) * i) / (rounds.length - 1);
  const y = v => PT + ((H - PT - PB) * (max - v)) / (max - min);

  const step = (max - min) / 5 >= 5 ? Math.ceil((max - min) / 5 / 5) * 5 : 5;
  let grid = '';
  for (let v = min; v <= max; v += step) {
    grid += `<line class="grid" x1="${PL}" x2="${W - PR}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="axis-label" x="${PL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }

  const a = avg(ys);
  const points = ys.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const dots = rounds.map((r, i) =>
    `<circle class="dot" cx="${x(i)}" cy="${y(ys[i])}" r="4"><title>${fmtDate(r.date)} ${esc(r.course)}：${ys[i]}</title></circle>`).join('');
  const dateLabel = (i, anchor) =>
    `<text class="axis-label" x="${x(i)}" y="${H - 8}" text-anchor="${anchor}">${fmtDate(rounds[i].date).slice(5)}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="スコア推移グラフ">
    ${grid}
    <line class="avg" x1="${PL}" x2="${W - PR}" y1="${y(a)}" y2="${y(a)}"><title>平均 ${a.toFixed(1)}</title></line>
    <polyline class="line" points="${points}"/>
    ${dots}
    ${dateLabel(0, 'start')}${dateLabel(rounds.length - 1, 'end')}
  </svg>
  <p class="muted">点線は平均スコア（${a.toFixed(1)}）。点にカーソルを合わせると詳細が見られます。</p>`;
}

/* =========================================================
 * バックアップ
 * ========================================================= */

$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `golf-scores-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#f-import').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!d || !Array.isArray(d.rounds)) throw new Error('形式が違います');
    const known = new Set(data.rounds.map(r => r.id));
    const added = d.rounds.filter(r => isValidRound(r) && !known.has(r.id));
    data.rounds.push(...added);
    for (const [name, c] of Object.entries(d.courses || {})) {
      if (!data.courses[name] && Array.isArray(c?.pars) && c.pars.length === HOLES) data.courses[name] = c;
    }
    saveData();
    refreshCourseList();
    refreshNameList();
    renderHoleRefs();
    renderStats();
    toast(`${added.length}件のラウンドを読み込みました`);
  } catch (err) {
    toast('読み込みに失敗しました：JSONファイルを確認してください');
  }
});

/* =========================================================
 * 初期化
 * ========================================================= */

buildRows();
refreshCourseList();
refreshNameList();
$('#f-date').value = today();
players = [newPlayer(defaultSelfName())];
renderPlayerList();
updateTotals();
if (restoreDraft()) toast('入力途中のデータを復元しました');
