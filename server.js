// Code Duel v2 — ระบบประลองการเขียนโปรแกรมเชิงแข่งขันแบบเรียลไทม์ (Python / C++)
// v2: รันโค้ดของผู้เล่นในคอนเทนเนอร์ Docker ที่แยกจากเครื่องเซิร์ฟเวอร์
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const createSandbox = require('./sandbox');
const insight = require('./insight');
const createStage = require('./stage');

// ---------- ค่าตั้งต้น (เปลี่ยนได้ผ่าน environment variables) ----------
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0'; // 0.0.0.0 = รับการเชื่อมต่อจากทุกเครื่องในวงแลน
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';
// จำนวนผู้เล่นเริ่มต้น และขีดจำกัดสูงสุด (ผู้ดูแลปรับได้จากหน้า admin)
const PLAYER_COUNT = Number(process.env.PLAYER_COUNT || 2);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 40);
// ที่รันโค้ด: docker (ค่าเริ่มต้น แยกในคอนเทนเนอร์) หรือ local (รันบนเครื่องนี้โดยตรงแบบ v1)
const EXECUTOR = (process.env.EXECUTOR || 'docker').toLowerCase();
const sandbox = createSandbox({
  executor: EXECUTOR,
  dockerCmd: process.env.DOCKER_CMD || 'docker',
  image: process.env.RUNNER_IMAGE || 'code-duel-runner:2',
  memory: process.env.RUNNER_MEMORY || '256m',      // หน่วยความจำต่อคอนเทนเนอร์
  cpus: Number(process.env.RUNNER_CPUS || 1),       // จำนวน CPU ต่อคอนเทนเนอร์
  pids: Number(process.env.RUNNER_PIDS || 64),      // จำนวนโปรเซสสูงสุด (กัน fork bomb)
  workSize: process.env.RUNNER_DISK || '64m',       // พื้นที่เขียนไฟล์ในคอนเทนเนอร์
  lifetimeSec: 1800,                                // คอนเทนเนอร์หมดอายุเองภายใน 30 นาที
  pythonCmd: process.env.PYTHON_CMD || (process.platform === 'win32' ? 'python' : 'python3'),
  cxxCmd: process.env.CXX_CMD || 'g++',
});
let sandboxInfo = '';
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 60000);   // เวลารันสูงสุด (โหมดรันโค้ด)
const COMPILE_TIMEOUT_MS = 20000;
const MAX_CODE = 100000;
const MAX_CONSOLE = 200000;
const MAX_JUDGE_OUT = 2 * 1024 * 1024;
// ที่เก็บคลังโจทย์ (ไฟล์ .md หนึ่งไฟล์ต่อหนึ่งโจทย์) และโจทย์ที่เผยแพร่ล่าสุด
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BANK_DIR = path.join(DATA_DIR, 'problems');
const CURRENT_FILE = path.join(DATA_DIR, 'current.json');
const EVENT_FILE = path.join(DATA_DIR, 'event.json');     // งานแข่งปัจจุบัน: รายชื่อ รหัสเข้าใช้ และผลทุกรอบ
const ARCHIVE_DIR = path.join(DATA_DIR, 'events');        // งานแข่งเก่าที่เก็บไว้
const REPLAY_DIR = path.join(DATA_DIR, 'replays');        // บันทึกการพิมพ์โค้ดของแต่ละคน แต่ละรอบ
const recorder = insight.createRecorder(REPLAY_DIR);
fs.mkdirSync(BANK_DIR, { recursive: true });

const TEMPLATES = {
  python: `# เขียนโค้ด Python ที่นี่\na, b = map(int, input().split())\nprint(a + b)\n`,
  cpp: `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    long long a, b;\n    cin >> a >> b;\n    cout << a + b << endl;\n    return 0;\n}\n`,
};

const DEFAULT_MARKDOWN = `# ผลรวมสองจำนวน

กำหนดจำนวนเต็ม $a$ และ $b$ ให้หาผลรวมของทั้งสองจำนวน

## ข้อมูลนำเข้า

บรรทัดเดียว มีจำนวนเต็ม $a$ และ $b$ คั่นด้วยช่องว่าง โดย $-10^9 \\le a, b \\le 10^9$

## ข้อมูลส่งออก

จำนวนเต็มหนึ่งจำนวน คือ $a + b$

## ตัวอย่าง

<example>
<input>
1 2
</input>
<output>
3
</output>
</example>

<example>
<input>
-5 10
</input>
<output>
5
</output>
</example>

<!-- เทสเคสลับ: ผู้เล่นมองไม่เห็นส่วนนี้ -->
<timelimit>2</timelimit>

<test>
<input>
100 200
</input>
<output>
300
</output>
</test>

<test>
<input>
1000000000 1000000000
</input>
<output>
2000000000
</output>
</test>

<test>
<input>
-7 -8
</input>
<output>
-15
</output>
</test>
`;

// ---------- แปลง markdown ของโจทย์ ----------
function cleanBlock(s) {
  return s.replace(/\r/g, '').replace(/^\n/, '').replace(/\s+$/, '') + '\n';
}
function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? cleanBlock(m[1]) : '';
}
function parseProblem(markdown) {
  const tests = [], examples = [];
  let timeLimit = 2;
  let pub = String(markdown || '').replace(/\r/g, '');
  pub = pub.replace(/<timelimit>\s*([\d.]+)\s*<\/timelimit>/gi, (_, t) => {
    timeLimit = Math.max(0.1, Math.min(30, Number(t) || 2)); return '';
  });
  // <test> = เทสเคสลับ → ตัดออกจากสิ่งที่ผู้เล่นได้รับ
  pub = pub.replace(/<test>([\s\S]*?)<\/test>/gi, (_, b) => {
    tests.push({ input: pickTag(b, 'input'), output: pickTag(b, 'output') }); return '';
  });
  // <example> = ตัวอย่างที่ผู้เล่นเห็น → แทนที่ด้วยจุดวางกล่องตัวอย่าง
  pub = pub.replace(/<example>([\s\S]*?)<\/example>/gi, (_, b) => {
    examples.push({ input: pickTag(b, 'input'), output: pickTag(b, 'output') });
    return `\n\n<div class="example" data-i="${examples.length - 1}"></div>\n\n`;
  });
  pub = pub.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const t = pub.match(/^#\s+(.+)$/m);
  return { title: t ? t[1].trim() : 'โจทย์', markdown: pub, examples, tests, timeLimit };
}
// ---------- คลังโจทย์ ----------
const validId = (id) => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id); // กันการอ่านไฟล์นอกโฟลเดอร์
const bankPath = (id) => path.join(BANK_DIR, `${id}.md`);
const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);

function bankList() {
  return fs.readdirSync(BANK_DIR)
    .filter((f) => f.endsWith('.md') && validId(f.slice(0, -3)))
    .map((f) => {
      const id = f.slice(0, -3);
      const full = path.join(BANK_DIR, f);
      const md = fs.readFileSync(full, 'utf8');
      const p = parseProblem(md);
      return { id, title: p.title, examples: p.examples.length, tests: p.tests.length, updatedAt: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function bankGet(id) {
  if (!validId(id) || !fs.existsSync(bankPath(id))) return null;
  return fs.readFileSync(bankPath(id), 'utf8');
}
function bankSave(id, markdown) {
  if (!validId(id)) id = newId();
  fs.writeFileSync(bankPath(id), markdown);
  return id;
}
function bankDelete(id) {
  if (validId(id) && fs.existsSync(bankPath(id))) fs.unlinkSync(bankPath(id));
}
function saveCurrent() {
  try { fs.writeFileSync(CURRENT_FILE, JSON.stringify({ source: state.source, publishedId: state.publishedId })); } catch (_) {}
}
function loadCurrent() {
  try { return JSON.parse(fs.readFileSync(CURRENT_FILE, 'utf8')); } catch (_) { return null; }
}

// โจทย์ที่ผู้เล่นได้รับ: ก่อนผู้ดูแลกดเริ่ม ส่งแค่ตัวแทนว่างเปล่า (ไม่มีเนื้อหาโจทย์หรือตัวอย่างหลุดไป)
const HIDDEN_PROBLEM = { hidden: true, title: 'รอเริ่มการแข่งขัน', markdown: '', examples: [], timeLimit: 0, testCount: 0 };
// ระหว่างนับถอยหลัง 3-2-1 ก็ยังซ่อนโจทย์
const playerProblem = () => (state.match.status === 'waiting' || Date.now() < (state.match.startedAt || 0) ? HIDDEN_PROBLEM : publicProblem(state.problem));
const broadcastProblem = () => io.except('admins').emit('problem', playerProblem());

const publicProblem = (p) => ({
  title: p.title, markdown: p.markdown, examples: p.examples,
  timeLimit: p.timeLimit, testCount: p.tests.length,
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });
app.use(express.static(path.join(__dirname, 'public')));
// ไลบรารีฝั่งเบราว์เซอร์ให้บริการจากเครื่องนี้เอง → ใช้ในวงแลนที่ไม่มีอินเทอร์เน็ตได้
const nm = (p) => path.join(__dirname, 'node_modules', p);
app.use('/vendor/monaco', express.static(nm('monaco-editor/min'), { maxAge: '7d' }));
app.use('/vendor/katex', express.static(nm('katex/dist'), { maxAge: '7d' }));   // สูตรคณิตศาสตร์ในโจทย์
app.get('/vendor/marked.min.js', (req, res) => res.sendFile(nm('marked/marked.min.js')));
app.get('/vendor/purify.min.js', (req, res) => res.sendFile(nm('dompurify/dist/purify.min.js')));

// หา IP ของเครื่องในวงแลน เพื่อบอกผู้ดูแลว่าเครื่องอื่นต้องเข้าที่อยู่ไหน
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}
const lanUrls = () => lanAddresses().map((a) => `http://${a.address}:${PORT}`);

// ---------- งานแข่ง: รายชื่อผู้เข้าแข่งขัน รหัสเข้าใช้ และผลแต่ละรอบ ----------
// ตัดตัวที่สับสนง่ายออก (O/0, I/1/L) เพื่อให้อ่านจากบัตรแล้วพิมพ์ถูก
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const fmtCode = (c) => c.slice(0, 3) + '-' + c.slice(3);
function genAccessCode(roster) {
  const used = new Set(Object.values(roster).map((r) => r.accessCode));
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!used.has(c)) return c;
  }
}
const newEvent = (name = 'การแข่งขัน') => ({ id: Date.now().toString(36), name, createdAt: Date.now(), roster: {}, rounds: [] });
function loadEvent() {
  try {
    const e = JSON.parse(fs.readFileSync(EVENT_FILE, 'utf8'));
    if (e && e.roster && Array.isArray(e.rounds)) return e;
  } catch (_) {}
  return null;
}
let saveTimer = null;
function saveEvent() {           // เขียนไฟล์แบบหน่วงเล็กน้อย รวมการเปลี่ยนแปลงที่เกิดติด ๆ กัน
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveEventNow, 200);
}
function saveEventNow() {
  clearTimeout(saveTimer);
  try {
    const tmp = EVENT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(event, null, 1));
    fs.renameSync(tmp, EVENT_FILE);
  } catch (e) { console.error('บันทึกผลการแข่งไม่สำเร็จ:', e.message); }
}
let event = loadEvent() || newEvent();

// ---------- สถานะของระบบ ----------
const newPlayer = () => ({
  name: '', connected: false, socketId: null,
  lang: 'python', code: TEMPLATES.python, console: [],
  running: false, judging: false, best: null, submissions: 0,
});

if (!fs.readdirSync(BANK_DIR).some((f) => f.endsWith('.md'))) bankSave('example-sum', DEFAULT_MARKDOWN); // ตัวอย่างโจทย์แรก
const saved = loadCurrent(); // โจทย์ที่เผยแพร่ไว้ก่อนปิดเซิร์ฟเวอร์
const state = {
  source: saved?.source ?? DEFAULT_MARKDOWN,
  problem: parseProblem(saved?.source ?? DEFAULT_MARKDOWN),
  publishedId: saved?.publishedId ?? null,   // id ในคลังของโจทย์ที่กำลังใช้ (ถ้ามี)
  match: { status: 'waiting', startedAt: null, durationMin: 30, round: null },
  winner: null,
  seatCount: 0,
  players: {},
};
const procs = {};        // โปรแกรมโหมดรันโค้ด (รับ stdin จากผู้เล่น) แยกตามที่นั่ง
const sessions = {};     // สภาพแวดล้อมที่กำลังใช้ (คอนเทนเนอร์) แยกตามที่นั่ง
const slots = () => Array.from({ length: state.seatCount }, (_, i) => i + 1);
const validSlot = (n) => Number.isInteger(n) && n >= 1 && n <= state.seatCount;
let matchTimer = null;
let stage = null;        // จอผู้ชม (สร้างหลังประกาศฟังก์ชันทั้งหมด)

const playerMeta = (p) => ({
  name: p.name, connected: p.connected, lang: p.lang, running: p.running,
  judging: p.judging, best: p.best, submissions: p.submissions,
});
const adminState = () => ({
  source: state.source, problem: publicProblem(state.problem), match: state.match, winner: state.winner,
  seatCount: state.seatCount, maxPlayers: MAX_PLAYERS,
  roster: rosterForAdmin(), eventName: event.name, roundCount: event.rounds.at(-1)?.no ?? 0,
  publishedId: state.publishedId, bank: bankList(), lanUrls: lanUrls(),
  executor: { mode: sandbox.mode, info: sandboxInfo },
  stage: stage?.adminState() ?? null,
  players: Object.fromEntries(slots().map((s) => [s, { ...playerMeta(state.players[s]), code: state.players[s].code, console: state.players[s].console }])),
});
const rosterForAdmin = () => Object.fromEntries(slots().map((s) => [s, {
  name: event.roster[s]?.name || '', accessCode: fmtCode(event.roster[s]?.accessCode || ''),
  connected: !!state.players[s]?.connected,
}]));
const emitRoster = () => io.to('admins').emit('admin:roster', rosterForAdmin());
const emitPlayerMeta = (slot) => {
  if (!state.players[slot]) return;
  io.to('admins').emit('player:meta', { slot, ...playerMeta(state.players[slot]) });
};
const toPlayer = (slot, ev, data) => { const id = state.players[slot]?.socketId; if (id) io.to(id).emit(ev, data); };

// ---------- console ----------
function pushConsole(slot, type, text) {
  const p = state.players[slot];
  if (!text || !p) return; // ที่นั่งอาจถูกยกเลิกระหว่างโปรแกรมทำงาน
  const entry = { type, text };
  p.console.push(entry);
  let total = p.console.reduce((s, e) => s + e.text.length, 0);
  while (total > MAX_CONSOLE && p.console.length > 1) total -= p.console.shift().text.length;
  toPlayer(slot, 'console', entry);
  io.to('admins').emit('player:console', { slot, ...entry });
}
function clearConsole(slot) {
  if (!state.players[slot]) return;
  state.players[slot].console = [];
  toPlayer(slot, 'console:clear');
  io.to('admins').emit('player:console:clear', { slot });
}
function setBusy(slot, key, value) {
  if (!state.players[slot]) return;
  state.players[slot][key] = value;
  toPlayer(slot, 'busy', { running: state.players[slot].running, judging: state.players[slot].judging });
  emitPlayerMeta(slot);
  stage?.busy(slot);
}

// ---------- เตรียมโปรแกรม (สร้างสภาพแวดล้อม + เขียนไฟล์ + คอมไพล์) ----------
// คืน session ที่พร้อมรัน หรือ null ถ้าคอมไพล์ไม่ผ่าน/ถูกยกเลิก
async function prepare(slot, purpose) {
  const p = state.players[slot];
  const { lang, code } = p;
  if (sandbox.mode === 'docker') pushConsole(slot, 'sys', '🐳 กำลังเตรียมคอนเทนเนอร์ ...\n');
  let session;
  try {
    session = await sandbox.open(slot, purpose);
  } catch (e) {
    pushConsole(slot, 'err', e.message + '\n');
    pushConsole(slot, 'sys', '✖ เตรียมสภาพแวดล้อมไม่สำเร็จ — แจ้งผู้ดูแล\n');
    return null;
  }
  sessions[slot] = session;
  if (p.abort || !state.players[slot]) { await session.destroy(); return null; }   // ถูกหยุดระหว่างรอ
  if (lang === 'cpp') pushConsole(slot, 'sys', '⚙ กำลังคอมไพล์ C++ ...\n');
  const res = await session.prepare(lang, code, COMPILE_TIMEOUT_MS);
  if (p.abort || session.destroyed) { await session.destroy(); return null; }
  if (!res.ok) {
    recorder.event(slot, 'ce');
    pushConsole(slot, 'err', res.output);
    pushConsole(slot, 'sys', '✖ คอมไพล์ไม่ผ่าน\n');
    await session.destroy();
    return null;
  }
  if (lang === 'cpp') {
    if (res.output.trim()) pushConsole(slot, 'err', res.output);
    pushConsole(slot, 'sys', '✔ คอมไพล์สำเร็จ\n');
  }
  return session;
}

function killProc(slot) {
  if (state.players[slot]) state.players[slot].abort = true;
  const s = sessions[slot];
  if (s) s.destroy().catch(() => {});
}

// ---------- โหมดรันโค้ด (โต้ตอบได้) ----------
async function runCode(slot, presetInput) {
  const p = state.players[slot];
  if (p.running || p.judging) return;
  p.abort = false;
  setBusy(slot, 'running', true);
  clearConsole(slot);
  if (p.lang === 'python') pushConsole(slot, 'sys', '▶ เริ่มรัน Python\n');
  recorder.event(slot, 'run');
  const session = await prepare(slot, 'run');
  if (!session) { if (p.abort) pushConsole(slot, 'sys', '■ หยุดแล้ว\n'); setBusy(slot, 'running', false); return; }

  const startedAt = Date.now();
  const child = session.spawnInteractive(RUN_TIMEOUT_MS);
  procs[slot] = child;
  // หลังกดหยุด ไม่แสดงข้อความที่โปรแกรมพ่นออกมาตอนถูกปิด
  child.stdout.on('data', (d) => { if (!p.abort) pushConsole(slot, 'out', d.toString()); });
  child.stderr.on('data', (d) => { if (!p.abort) pushConsole(slot, 'err', session.cleanError(d.toString())); });
  child.stdin.on('error', () => {});
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, RUN_TIMEOUT_MS - 50);
  child.on('error', (e) => pushConsole(slot, 'err', `รันโปรแกรมไม่ได้: ${e.message}\n`));
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (procs[slot] === child) procs[slot] = null;
    session.destroy().catch(() => {});
    if (sessions[slot] === session) delete sessions[slot];
    if (timedOut) pushConsole(slot, 'sys', `\n⏱ เกินเวลา ${RUN_TIMEOUT_MS / 1000} วินาที — หยุดโปรแกรม\n`);
    const how = p.abort ? 'ถูกหยุด' : signal ? `ถูกหยุด (${signal})` : code === 137 && sandbox.mode === 'docker' ? 'ถูกหยุด (เกินเวลาหรือหน่วยความจำ)' : `exit code ${code}`;
    pushConsole(slot, 'sys', `\n■ จบการทำงาน — ${how} — ${Date.now() - startedAt} ms\n`);
    setBusy(slot, 'running', false);
  });
  if (typeof presetInput === 'string') {
    pushConsole(slot, 'in', presetInput);
    child.stdin.end(presetInput);
  }
}

// ---------- โหมดส่งคำตอบ (ตรวจกับเทสเคสลับ) ----------
const normalize = (s) => s.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join('\n').trimEnd();
const VERDICT = { AC: 'ผ่าน', WA: 'คำตอบผิด', TLE: 'เกินเวลา', MLE: 'หน่วยความจำเกิน', RE: 'รันไม่สำเร็จ', OLE: 'ผลลัพธ์ยาวเกินไป' };

async function judge(slot) {
  const p = state.players[slot];
  if (p.running || p.judging) return;
  const problem = state.problem;
  setBusy(slot, 'judging', true);
  p.abort = false;
  clearConsole(slot);
  pushConsole(slot, 'sys', `📤 ส่งคำตอบครั้งที่ ${p.submissions + 1} — ตรวจกับเทสเคสลับ ${problem.tests.length} ชุด (จำกัด ${problem.timeLimit} วินาที/ชุด)\n`);
  if (!problem.tests.length) {
    pushConsole(slot, 'sys', 'โจทย์นี้ยังไม่มีเทสเคสลับ — แจ้งผู้ดูแล\n');
    setBusy(slot, 'judging', false);
    return;
  }
  const session = await prepare(slot, 'judge');
  const prog = !!session;
  const verdicts = [];
  if (session) {
    for (let i = 0; i < problem.tests.length; i++) {
      if (p.abort || session.destroyed) break;
      const t = problem.tests[i];
      const r = await session.runTest(t.input, problem.timeLimit * 1000, MAX_JUDGE_OUT);
      if (p.abort || session.destroyed) break;
      let v = 'AC';
      if (r.tle) v = 'TLE';
      else if (r.mle) v = 'MLE';
      else if (r.ole) v = 'OLE';
      else if (r.code !== 0) v = 'RE';
      else if (normalize(r.out) !== normalize(t.output)) v = 'WA';
      verdicts.push(v);
      pushConsole(slot, v === 'AC' ? 'in' : 'err', `เทสเคส ${i + 1}: ${v === 'AC' ? '✔' : '✖'} ${VERDICT[v]} (${r.ms} ms)\n`);
    }
  }
  const passed = verdicts.filter((v) => v === 'AC').length;
  const total = problem.tests.length;
  if (session) { await session.destroy(); if (sessions[slot] === session) delete sessions[slot]; }
  const aborted = p.abort;
  p.submissions += 1;
  if (!aborted) {
    recorder.event(slot, 'submit', { passed, total });
    if (!p.best || passed > p.best.passed) p.best = { passed, total, at: Date.now() };
    pushConsole(slot, 'sys', prog ? `\n■ ผลการส่ง: ผ่าน ${passed}/${total} ชุด\n` : `\n■ ผลการส่ง: คอมไพล์ไม่ผ่าน (0/${total})\n`);
    toPlayer(slot, 'score', { best: p.best, submissions: p.submissions });
    if (state.match.status === 'running') stage.submit(slot, p.name, passed, total);
    if (passed === total && !state.winner && state.match.status === 'running') {
      state.winner = { slot, name: p.name, at: Date.now(), elapsedMs: Date.now() - state.match.startedAt };
      // ช่วงแช่แข็งตาราง: ผู้ดูแลเห็นทันที แต่ผู้เล่น/ผู้ชมจะรู้ตอนประกาศผล
      if (stage.isFrozen()) io.to('admins').emit('winner', state.winner);
      else io.emit('winner', state.winner);
    }
  } else {
    pushConsole(slot, 'sys', '\n■ หยุดการตรวจ\n');
  }
  setBusy(slot, 'judging', false);
}

// ---------- จำนวนที่นั่ง ----------
function kickSeat(slot, reason) {
  const p = state.players[slot];
  if (!p) return;
  killProc(slot);
  const s = p.socketId && io.sockets.sockets.get(p.socketId);
  if (s) { s.emit('kicked', reason); s.data.slot = null; }
}
// จำนวนผู้เข้าแข่งขัน: เพิ่ม = สร้างรหัสเข้าใช้ใหม่ให้, ลด = ยกเลิกคนท้าย ๆ (ผลรอบที่จบแล้วยังอยู่)
function setSeatCount(n) {
  for (let s = 1; s <= n; s++) {
    if (!event.roster[s]) event.roster[s] = { name: '', accessCode: genAccessCode(event.roster) };
    if (!state.players[s]) state.players[s] = { ...newPlayer(), name: event.roster[s].name };
  }
  for (let s = n + 1; s <= Math.max(state.seatCount, Object.keys(event.roster).length); s++) {
    kickSeat(s, 'ผู้ดูแลยกเลิกรหัสนี้แล้ว');
    delete state.players[s]; delete event.roster[s];
    delete procs[s]; delete sessions[s];
    if (state.winner && state.winner.slot === s) { state.winner = null; io.emit('winner', null); }
  }
  state.seatCount = n;
  saveEvent();
  io.to('admins').emit('admin:state', adminState()); // ให้หน้า admin สร้างการ์ดใหม่
  stage?.roster();
}
setSeatCount(Math.max(1, Math.min(MAX_PLAYERS, Object.keys(event.roster).length || PLAYER_COUNT)));

// ---------- การแข่งขัน ----------
const matchPayload = () => ({ ...state.match, serverNow: Date.now() });   // serverNow ให้แต่ละเครื่องปรับนาฬิกาให้ตรงกัน
function broadcastMatch() {
  io.emit('match', matchPayload());
  broadcastProblem(); // เริ่มแข่ง = เปิดโจทย์, รีเซ็ต = ซ่อนโจทย์อีกครั้ง
}
function endMatch() {
  clearTimeout(matchTimer);
  if (state.match.status !== 'running') return;
  state.match.status = 'ended';
  slots().forEach(killProc);
  finalizeRound();
  broadcastMatch();
}

// ---------- รอบการแข่ง ----------
const currentRound = () => event.rounds.find((r) => r.no === state.match.round) || null;
// เรียงอันดับ: ผ่านมากกว่าก่อน → ทำได้เร็วกว่าก่อน → ส่งน้อยครั้งกว่าก่อน
function rankRows(rows) {
  rows.sort((a, b) => b.passed - a.passed || (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity) || a.submissions - b.submissions || a.slot - b.slot);
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && prev.passed === r.passed && prev.timeMs === r.timeMs ? prev.rank : i + 1;
    r.points = r.total ? Math.round((r.passed / r.total) * 100) : 0;
  });
  return rows;
}
function liveRows(round) {
  return rankRows(slots().map((s) => {
    const p = state.players[s];
    return {
      slot: s, name: event.roster[s]?.name || `ผู้เข้าแข่งขัน ${s}`,
      passed: p.best?.passed ?? 0, total: round.testCount,
      timeMs: p.best && p.best.passed > 0 ? p.best.at - round.startedAt : null,
      submissions: p.submissions, lang: p.lang, code: p.code,
    };
  }));
}
function startRound(durationMin, startedAt) {
  const no = (event.rounds.at(-1)?.no ?? 0) + 1;
  const round = {
    no, title: state.problem.title, problemId: state.publishedId, source: state.source,
    testCount: state.problem.tests.length, timeLimit: state.problem.timeLimit,
    durationMin, startedAt, endedAt: null, results: null,
  };
  event.rounds.push(round);
  saveEvent();
  return round;
}
function finalizeRound() {
  const round = currentRound();
  if (!round) return;
  round.endedAt = Date.now();
  round.results = liveRows(round).map((r) => ({ ...r, pastes: recorder.pastes(r.slot) }));
  recorder.finish(event.id);
  saveEventNow();
  const wasFrozen = stage.isFrozen();
  stage.roundEnd(round);
  if (wasFrozen) {
    // ตารางแช่แข็งอยู่: ผู้เล่นเห็นผลของตัวเองเท่านั้น อันดับรอประกาศบนจอ
    const pub = publicRoundResult(round);
    for (const row of pub.rows) toPlayer(row.slot, 'round:result', { ...pub, rows: [row], frozen: true });
  } else {
    io.emit('round:result', publicRoundResult(round));
  }
  io.to('admins').emit('results:changed');
}
// สิ่งที่ผู้เล่นเห็นตอนจบรอบ (ไม่มีโค้ดของคนอื่น)
const publicRoundResult = (r) => ({
  no: r.no, title: r.title, testCount: r.testCount,
  rows: (r.results || []).map(({ slot, name, rank, passed, total, timeMs, submissions, points }) => ({ slot, name, rank, passed, total, timeMs, submissions, points })),
});
function overallStandings() {
  const done = event.rounds.filter((r) => r.results);
  const by = {};
  for (const r of done) for (const row of r.results) {
    const o = (by[row.slot] ??= { slot: row.slot, name: row.name, points: 0, timeMs: 0, solved: 0, rounds: {} });
    o.name = event.roster[row.slot]?.name || row.name;
    o.points += row.points;
    if (row.timeMs != null) o.timeMs += row.timeMs;
    if (row.total && row.passed === row.total) o.solved += 1;
    o.rounds[r.no] = row.points;
  }
  const rows = Object.values(by).sort((a, b) => b.points - a.points || a.timeMs - b.timeMs || a.slot - b.slot);
  rows.forEach((r, i) => { const p = rows[i - 1]; r.rank = p && p.points === r.points && p.timeMs === r.timeMs ? p.rank : i + 1; });
  return { rounds: done.map((r) => ({ no: r.no, title: r.title })), rows };
}
function resetScores() {
  state.winner = null;
  io.emit('winner', null);
  for (const s of slots()) {
    const p = state.players[s];
    p.best = null; p.submissions = 0;
    toPlayer(s, 'score', { best: null, submissions: 0 });
    emitPlayerMeta(s);
  }
}

// ---------- จอผู้ชม ----------
stage = createStage({
  io,
  getEvent: () => event,
  saveEvent,
  getMatch: () => state.match,
  currentRound,
  rawRows: () => {
    const round = currentRound() || { testCount: state.problem.tests.length, startedAt: state.match.startedAt || Date.now() };
    return liveRows(round).map((r) => ({ ...r, named: !!event.roster[r.slot]?.name || !!state.players[r.slot]?.connected }));
  },
  playerInfo: (slot) => {
    const p = state.players[slot] || {};
    return { lang: p.lang, lines: (p.code || '').split('\n').length, lastActive: p.lastActive ? Date.now() - p.lastActive : null,
      running: !!p.running, judging: !!p.judging, connected: !!p.connected };
  },
  codeNow: (slot) => ({ code: state.players[slot]?.code ?? '', lang: state.players[slot]?.lang ?? 'python' }),
  codeAt: (slot, t) => recorder.codeAt(slot, t) || { code: state.players[slot]?.code ?? '', lang: state.players[slot]?.lang ?? 'python' },
});
// ประกาศผลครบแล้ว → ผู้เล่นเห็นอันดับทั้งหมด และผู้ชนะ
stage.onRevealDone(() => {
  const round = [...event.rounds].reverse().find((r) => r.results);
  if (round) io.emit('round:result', publicRoundResult(round));
  if (state.winner) io.emit('winner', state.winner);
});

// ---------- socket ----------
io.on('connection', (socket) => {
  // กันเซิร์ฟเวอร์ล่มจากข้อมูลผิดรูปแบบที่ส่งมาจากเบราว์เซอร์: จับ error ของทุก handler
  const rawOn = socket.on.bind(socket);
  socket.on = (ev, fn) => rawOn(ev, (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch((e) => console.error(`[${ev}]`, e));
    } catch (e) { console.error(`[${ev}]`, e.message); }
  });
  socket.emit('problem', playerProblem());
  socket.emit('match', matchPayload());
  socket.emit('winner', state.winner);

  // เข้าใช้ด้วยรหัสที่ผู้ดูแลแจก (ครั้งแรกถ้ายังไม่มีชื่อ จะขอให้กรอกชื่อ)
  socket.on('player:join', ({ accessCode, name } = {}, cb = () => {}) => {
    const now = Date.now();
    if ((socket.data.lockUntil || 0) > now) {
      return cb({ ok: false, error: `ใส่รหัสผิดหลายครั้ง — ลองใหม่ใน ${Math.ceil((socket.data.lockUntil - now) / 1000)} วินาที` });
    }
    const code = normCode(accessCode);
    const slot = slots().find((s) => event.roster[s]?.accessCode === code);
    if (!slot) {
      socket.data.fails = (socket.data.fails || 0) + 1;
      if (socket.data.fails >= 5) { socket.data.lockUntil = now + 60000; socket.data.fails = 0; }
      return cb({ ok: false, badCode: true, error: code ? 'รหัสเข้าใช้ไม่ถูกต้อง' : 'กรอกรหัสเข้าใช้' });
    }
    socket.data.fails = 0;
    const r = event.roster[slot];
    name = String(name || '').trim().slice(0, 40);
    if (!r.name) {
      if (!name) return cb({ ok: false, needName: true, error: 'กรอกชื่อของคุณ (ครั้งแรกครั้งเดียว)' });
      r.name = name; saveEvent(); emitRoster(); stage?.roster();
    }
    const p = state.players[slot];
    if (p.connected && p.socketId !== socket.id) {
      return cb({ ok: false, error: 'รหัสนี้กำลังใช้งานอยู่ที่เครื่องอื่น — แจ้งผู้ดูแลถ้าไม่ใช่คุณ' });
    }
    p.name = r.name; p.connected = true; p.socketId = socket.id;
    socket.data.slot = slot;
    emitPlayerMeta(slot); emitRoster(); stage.roster();
    io.to('admins').emit('player:code', { slot, code: p.code, lang: p.lang });
    const last = event.rounds.at(-1);
    cb({ ok: true, slot, name: r.name, accessCode: fmtCode(r.accessCode), lang: p.lang, code: p.code, console: p.console, running: p.running,
      judging: p.judging, best: p.best, submissions: p.submissions, templates: TEMPLATES,
      lastResult: state.match.status === 'ended' && last?.results ? publicRoundResult(last) : null });
  });

  socket.on('code:update', ({ code, lang } = {}) => {
    const slot = socket.data.slot;
    if (!slot || typeof code !== 'string' || state.match.status === 'ended') return;
    const p = state.players[slot];
    p.code = code.slice(0, MAX_CODE);
    if (lang === 'python' || lang === 'cpp') p.lang = lang;
    p.lastActive = Date.now();
    if (state.match.status === 'running') recorder.code(slot, p.code, p.lang);
    io.to('admins').emit('player:code', { slot, code: p.code, lang: p.lang });
    stage.code(slot);
    emitPlayerMeta(slot);
  });

  const needRunning = (slot) => {
    if (state.match.status === 'running' && Date.now() < state.match.startedAt) {
      pushConsole(slot, 'sys', 'รอสัญญาณเริ่ม ...\n');
      return false;
    }
    if (state.match.status === 'running') return true;
    pushConsole(slot, 'sys', state.match.status === 'ended' ? 'หมดเวลาการแข่งขันแล้ว\n' : 'ยังทำไม่ได้ — รอผู้ดูแลเริ่มการแข่งขัน\n');
    return false;
  };

  socket.on('run', ({ stdin } = {}) => {
    const slot = socket.data.slot;
    if (slot && needRunning(slot)) runCode(slot, typeof stdin === 'string' ? stdin : undefined);
  });
  socket.on('submit', () => {
    const slot = socket.data.slot;
    if (slot && needRunning(slot)) judge(slot);
  });
  socket.on('stdin', (text) => {
    const slot = socket.data.slot;
    const child = slot && procs[slot];
    if (!child || typeof text !== 'string') return;
    pushConsole(slot, 'in', text);
    child.stdin.write(text);
  });
  socket.on('stdin:eof', () => {
    const child = socket.data.slot && procs[socket.data.slot];
    if (child) child.stdin.end();
  });
  socket.on('stop', () => { if (socket.data.slot) killProc(socket.data.slot); });

  // ---------- ผู้ดูแล ----------
  socket.on('admin:login', (password, cb = () => {}) => {
    if (password !== ADMIN_PASSWORD) return cb({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
    socket.data.admin = true;
    socket.join('admins');
    cb({ ok: true, state: adminState() });
  });
  const adminOnly = (fn) => (...args) => { if (socket.data.admin) fn(...args); };

  socket.on('admin:preview', adminOnly((markdown, cb = () => {}) => {
    cb(publicProblem(parseProblem(String(markdown || '').slice(0, 2e6))));
  }));
  socket.on('admin:problem', adminOnly((data, cb = () => {}) => {
    const markdown = typeof data === 'string' ? data : data?.markdown;
    state.source = String(markdown || '').slice(0, 2e6);
    state.problem = parseProblem(state.source);
    state.publishedId = validId(data?.bankId) ? data.bankId : null;
    saveCurrent();
    io.to('admins').emit('bank:published', state.publishedId);
    resetScores();
    if (state.match.status === 'ended') {
      // เผยแพร่โจทย์ใหม่หลังจบรอบ = เริ่มรอบใหม่ → กลับไปสถานะรอเริ่ม โจทย์ถูกซ่อนจนกว่าจะกดเริ่ม
      clearTimeout(matchTimer);
      state.match = { status: 'waiting', startedAt: null, durationMin: state.match.durationMin, round: null };
      broadcastMatch();
    } else {
      broadcastProblem();
    }
    io.to('admins').emit('admin:source', state.source);
    cb(publicProblem(state.problem));
  }));

  // ---------- คลังโจทย์ ----------
  const sendBank = () => io.to('admins').emit('bank:list', bankList());
  socket.on('bank:get', adminOnly((id, cb = () => {}) => {
    const markdown = bankGet(id);
    cb(markdown === null ? { ok: false, error: 'ไม่พบโจทย์นี้ในคลัง' } : { ok: true, id, markdown });
  }));
  socket.on('bank:save', adminOnly(({ id, markdown } = {}, cb = () => {}) => {
    markdown = String(markdown || '');
    if (!markdown.trim()) return cb({ ok: false, error: 'โจทย์ว่างเปล่า' });
    if (markdown.length > 2e6) return cb({ ok: false, error: 'โจทย์ยาวเกิน 2 MB' });
    try {
      const savedId = bankSave(id, markdown);
      sendBank();
      cb({ ok: true, id: savedId });
    } catch (e) { cb({ ok: false, error: 'บันทึกไม่สำเร็จ: ' + e.message }); }
  }));
  socket.on('bank:delete', adminOnly((id, cb = () => {}) => {
    bankDelete(id);
    if (state.publishedId === id) { state.publishedId = null; saveCurrent(); io.to('admins').emit('bank:published', null); }
    sendBank();
    cb({ ok: true });
  }));

  socket.on('admin:match', adminOnly(({ action, durationMin } = {}) => {
    if (action === 'start') {
      clearTimeout(matchTimer);
      const d = Math.max(1, Math.min(600, Number(durationMin) || 30));
      // กำลังแข่งอยู่แล้วกดเริ่มอีก = นับเวลารอบเดิมใหม่, ไม่งั้น = เปิดรอบใหม่
      const lead = stage.settings().countdown ? 3500 : 0;          // นับถอยหลัง 3-2-1 ก่อนเปิดโจทย์
      const startedAt = Date.now() + lead;
      let round = state.match.status === 'running' ? currentRound() : null;
      if (round) { round.startedAt = startedAt; round.durationMin = d; saveEvent(); }
      else round = startRound(d, startedAt);
      recorder.start(round, state.players);   // เริ่มบันทึกการพิมพ์ของทุกคนสำหรับ Replay
      state.match = { status: 'running', startedAt, durationMin: d, round: round.no };
      matchTimer = setTimeout(endMatch, lead + d * 60000);
      resetScores();
      stage.roundStart(round, startedAt, d * 60000);
      broadcastMatch();
      if (lead) setTimeout(() => { if (state.match.round === round.no && state.match.startedAt === startedAt) broadcastProblem(); }, lead + 30);
    } else if (action === 'end') {
      endMatch();
    } else if (action === 'reset') {
      clearTimeout(matchTimer);
      if (state.match.status === 'running') endMatch();   // กดเตรียมรอบถัดไประหว่างแข่ง = จบรอบนี้ก่อน
      state.match = { status: 'waiting', startedAt: null, durationMin: state.match.durationMin, round: null };
      for (const s of slots()) {
        killProc(s);
        const p = state.players[s];
        p.code = TEMPLATES[p.lang];
        clearConsole(s);
        toPlayer(s, 'code:reset', { code: p.code, lang: p.lang });
        io.to('admins').emit('player:code', { slot: s, code: p.code, lang: p.lang });
      }
      resetScores();
      stage.roundReset();
      broadcastMatch();
    }
  }));

  // ---------- รายชื่อและรหัสเข้าใช้ ----------
  socket.on('admin:roster:name', adminOnly(({ slot, name } = {}, cb = () => {}) => {
    slot = Number(slot);
    if (!validSlot(slot)) return cb({ ok: false });
    event.roster[slot].name = String(name || '').trim().slice(0, 40);
    if (state.players[slot]) { state.players[slot].name = event.roster[slot].name; emitPlayerMeta(slot); }
    toPlayer(slot, 'me:name', event.roster[slot].name);
    saveEvent(); emitRoster(); stage.roster();
    cb({ ok: true });
  }));
  socket.on('admin:roster:regen', adminOnly((slot, cb = () => {}) => {
    slot = Number(slot);
    if (!validSlot(slot)) return cb({ ok: false });
    kickSeat(slot, 'ผู้ดูแลเปลี่ยนรหัสเข้าใช้ของคุณ — ขอรหัสใหม่จากผู้ดูแล');
    if (state.players[slot]) { state.players[slot].connected = false; state.players[slot].socketId = null; emitPlayerMeta(slot); }
    event.roster[slot].accessCode = genAccessCode(event.roster);
    saveEvent(); emitRoster();
    cb({ ok: true });
  }));

  // ---------- จอผู้ชม ----------
  socket.on('scoreboard:join', (...args) => {
    const cb = args.find((a) => typeof a === 'function') || (() => {});
    stage.joinScoreboard(socket, cb);
  });
  socket.on('spectator:join', (key, cb = () => {}) => stage.joinSpectator(socket, String(key || ''), cb));
  socket.on('stage:settings', adminOnly((p) => stage.setSettings(p)));
  socket.on('stage:key:rotate', adminOnly(() => stage.rotateKey()));
  socket.on('stage:reveal', adminOnly(({ all } = {}) => stage.revealNext(!!all)));

  // ---------- สรุปผล ----------
  socket.on('results:get', adminOnly((...args) => {
    const cb = args.find((a) => typeof a === 'function') || (() => {});
    cb({ eventName: event.name, createdAt: event.createdAt, rounds: event.rounds,
      overall: overallStandings(), currentRound: state.match.round, status: state.match.status });
  }));
  // ย้อนดูการพิมพ์โค้ดของคนหนึ่งในรอบหนึ่ง
  socket.on('replay:get', adminOnly(({ round, slot } = {}, cb = () => {}) => {
    const r = event.rounds.find((x) => x.no === Number(round));
    const data = r && insight.readReplay(REPLAY_DIR, event.id, r.no, slot);
    if (!data) return cb({ ok: false, error: 'ไม่มีบันทึกการพิมพ์ของรอบนี้ (รอบยังไม่จบ หรือเซิร์ฟเวอร์ถูกปิดกลางรอบ)' });
    const row = r.results?.find((x) => x.slot === Number(slot));
    cb({ ok: true, replay: data, round: { no: r.no, title: r.title, testCount: r.testCount, durationMin: r.durationMin },
      player: { slot: Number(slot), name: row?.name || event.roster[slot]?.name || `ผู้เข้าแข่งขัน ${slot}` }, result: row || null,
      others: (r.results || []).map((x) => ({ slot: x.slot, name: x.name })) });
  }));
  // ตรวจความคล้ายของโค้ดสุดท้ายในรอบ
  socket.on('similarity:get', adminOnly((roundNo, cb = () => {}) => {
    const r = event.rounds.find((x) => x.no === Number(roundNo));
    if (!r?.results) return cb({ ok: false, error: 'รอบนี้ยังไม่จบ' });
    const rows = r.results.filter((x) => x.code && x.code.trim()).map(({ slot, name, lang, code }) => ({ slot, name, lang, code }));
    cb({ ok: true, pairs: insight.similarity(rows, TEMPLATES).slice(0, 200) });
  }));

  socket.on('admin:event:rename', adminOnly((name, cb = () => {}) => {
    event.name = String(name || '').trim().slice(0, 100) || 'การแข่งขัน';
    saveEvent(); io.to('admins').emit('results:changed'); cb({ ok: true });
  }));
  socket.on('admin:round:delete', adminOnly((no, cb = () => {}) => {
    if (state.match.status === 'running' && state.match.round === no) return cb({ ok: false, error: 'ลบรอบที่กำลังแข่งไม่ได้' });
    event.rounds = event.rounds.filter((r) => r.no !== no);
    insight.deleteReplays(REPLAY_DIR, event.id, no);
    saveEvent(); io.to('admins').emit('results:changed'); cb({ ok: true });
  }));
  // เริ่มงานแข่งใหม่: เก็บงานเดิมไว้ใน data/events แล้วล้างผลทุกรอบ
  socket.on('admin:event:new', adminOnly(({ name, keepRoster } = {}, cb = () => {}) => {
    if (state.match.status === 'running') return cb({ ok: false, error: 'จบรอบที่กำลังแข่งก่อน' });
    try {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      if (event.rounds.length) fs.writeFileSync(path.join(ARCHIVE_DIR, `${event.id}.json`), JSON.stringify(event, null, 1));
    } catch (e) { return cb({ ok: false, error: 'เก็บงานเดิมไม่สำเร็จ: ' + e.message }); }
    const n = state.seatCount;
    const old = event;
    event = newEvent(String(name || '').trim().slice(0, 100) || 'การแข่งขัน');
    if (keepRoster) event.roster = old.roster;
    else for (const s of slots()) kickSeat(s, 'เริ่มงานแข่งใหม่ — ขอรหัสเข้าใช้ใหม่จากผู้ดูแล');
    state.match = { status: 'waiting', startedAt: null, durationMin: state.match.durationMin, round: null };
    for (const s of slots()) {
      if (!keepRoster) state.players[s] = newPlayer();
      else { state.players[s].best = null; state.players[s].submissions = 0; }
    }
    setSeatCount(n);
    saveEventNow();
    stage.reset();
    state.winner = null; io.emit('winner', null);
    broadcastMatch();
    io.to('admins').emit('results:changed');
    cb({ ok: true });
  }));

  socket.on('admin:kick', adminOnly((slot) => {
    slot = Number(slot);
    if (!validSlot(slot)) return;
    kickSeat(slot, 'ผู้ดูแลนำคุณออกจากระบบ — เข้าใหม่ด้วยรหัสเดิมได้');
    state.players[slot] = { ...newPlayer(), name: event.roster[slot]?.name || '' };
    emitPlayerMeta(slot); emitRoster();
    io.to('admins').emit('player:code', { slot, code: state.players[slot].code, lang: 'python' });
    io.to('admins').emit('player:console:clear', { slot });
  }));

  socket.on('admin:seatCount', adminOnly((count, cb = () => {}) => {
    const n = Math.round(Number(count));
    if (!(n >= 1 && n <= MAX_PLAYERS)) return cb({ ok: false, error: `จำนวนผู้เข้าแข่งขันต้องอยู่ระหว่าง 1 ถึง ${MAX_PLAYERS}` });
    setSeatCount(n);
    cb({ ok: true });
  }));

  socket.on('disconnect', () => {
    const slot = socket.data.slot;
    if (slot && state.players[slot].socketId === socket.id) {
      killProc(slot);
      state.players[slot].connected = false;
      state.players[slot].socketId = null;
      emitPlayerMeta(slot); emitRoster();
    }
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`พอร์ต ${PORT} ถูกใช้อยู่ — ปิดโปรแกรมที่ใช้พอร์ตนี้ หรือรันด้วย PORT=อื่น`);
  else console.error(e);
  process.exit(1);
});

(async () => {
  const chk = await sandbox.check();
  if (!chk.ok) {
    console.error('\n✖ เริ่มระบบไม่ได้: ' + chk.message);
    console.error('  ถ้าต้องการรันโค้ดบนเครื่องนี้โดยตรงแบบ v1 (ไม่ปลอดภัย): EXECUTOR=local npm start\n');
    process.exit(1);
  }
  sandboxInfo = chk.message;
  const stale = await sandbox.cleanupAll();
  if (stale) console.log(`  ลบคอนเทนเนอร์ที่ค้างจากครั้งก่อน ${stale} ตัว`);
  server.listen(PORT, HOST, () => {
    const lan = lanAddresses();
    console.log(`Code Duel v${require('./package.json').version} พร้อมใช้งาน`);
    console.log(`  Node.js ${process.version} — ตรวจว่าเป็นรุ่นล่าสุดของสายนี้ที่ https://nodejs.org`);
    console.log(`  ที่รันโค้ด : ${sandboxInfo}`);
    console.log(`  เครื่องนี้ : http://localhost:${PORT}/admin.html  (รหัสผู้ดูแล: ${ADMIN_PASSWORD})`);
    if (!lan.length) console.log('  ไม่พบการ์ดเครือข่าย — ตรวจว่าเครื่องต่อวงแลน/Wi-Fi แล้ว');
    for (const a of lan) {
      console.log(`  วงแลน (${a.name}) : ผู้เล่นเข้า http://${a.address}:${PORT}/player.html`);
    }
    console.log('  ถ้าเครื่องอื่นเข้าไม่ได้ ดูหัวข้อ "เล่นในวงแลน" ใน README.md (มักเป็นไฟร์วอลล์)');
  });
})();

// ปิดเซิร์ฟเวอร์ (Ctrl+C) → ลบคอนเทนเนอร์ที่ยังทำงานอยู่ก่อน
let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log('\nกำลังปิดเซิร์ฟเวอร์ และลบคอนเทนเนอร์ ...');
    await Promise.allSettled(Object.values(sessions).map((x) => x.destroy()));
    await sandbox.cleanupAll().catch(() => {});
    saveEventNow();
    process.exit(0);
  });
}

