// insight.js — เครื่องมือสำหรับผู้ดูแล/ครู
//   1) บันทึกการพิมพ์โค้ดของแต่ละคนตลอดรอบ เพื่อย้อนดู (Replay)
//   2) ตรวจความคล้ายของโค้ดระหว่างผู้เข้าแข่งขันในรอบเดียวกัน
const fs = require('fs');
const path = require('path');

// ====================================================================
// Replay: เก็บเฉพาะส่วนที่เปลี่ยน (diff) ไม่เก็บทั้งไฟล์ทุกครั้ง ไฟล์จึงเล็ก
// ====================================================================
const MAX_OPS = 30000;          // กันไฟล์ใหญ่เกินจากคนที่พิมพ์ทั้งรอบ
const PASTE_CHARS = 80;         // แทรกข้อความยาวเกินนี้ในครั้งเดียว = น่าจะวางโค้ด

// หาส่วนที่ต่างกันระหว่างข้อความเก่า/ใหม่: ตัดส่วนหน้าและท้ายที่เหมือนกันออก
function diffOp(a, b) {
  let s = 0;
  const m = Math.min(a.length, b.length);
  while (s < m && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < m - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
  return { p: s, d: a.length - s - e, i: b.slice(s, b.length - e) };
}

function createRecorder(dir) {
  let rec = {};                 // slot -> { startCode, lang, last, ops, events, pastes, full }
  let round = null;

  return {
    start(r, players) {
      round = r;
      rec = {};
      for (const [slot, p] of Object.entries(players)) {
        rec[slot] = { startCode: p.code, lang: p.lang, last: p.code, curLang: p.lang, ops: [], events: [], pastes: 0, full: false };
      }
    },
    active: () => !!round,
    code(slot, code, lang) {
      const r = round && rec[slot];
      if (!r || r.full) return;
      const t = Date.now() - round.startedAt;
      if (code === r.last && lang === r.curLang) return;
      const op = { t, ...diffOp(r.last, code) };
      if (lang !== r.curLang) { op.l = lang; r.curLang = lang; }
      // ข้อความยาวเข้ามาในครั้งเดียว = วางโค้ด (ยกเว้นตอนสลับภาษา ซึ่งตัวเขียนสลับไปใช้โค้ดอีกชุด)
      if (op.i.length >= PASTE_CHARS && !op.l) { op.paste = 1; r.pastes++; }
      r.ops.push(op);
      r.last = code;
      if (r.ops.length >= MAX_OPS) r.full = true;
    },
    event(slot, type, detail = {}) {
      const r = round && rec[slot];
      if (!r) return;
      r.events.push({ t: Date.now() - round.startedAt, type, ...detail });
    },
    pastes: (slot) => rec[slot]?.pastes ?? 0,
    // โค้ด ณ เวลา t (ms นับจากเริ่มรอบ) ใช้กับจอผู้ชมแบบหน่วงเวลา; จำตำแหน่งล่าสุดไว้ เดินหน้าต่อได้เร็ว
    codeAt(slot, t) {
      const r = round && rec[slot];
      if (!r) return null;
      let c = r.cache;
      if (!c || t < c.t) c = { i: 0, text: r.startCode, lang: r.lang, t: -Infinity };
      while (c.i < r.ops.length && r.ops[c.i].t <= t) {
        const op = r.ops[c.i++];
        c.text = c.text.slice(0, op.p) + op.i + c.text.slice(op.p + op.d);
        if (op.l) c.lang = op.l;
      }
      c.t = t;
      r.cache = c;
      return { code: c.text, lang: c.lang };
    },
    // จบรอบ: เขียนไฟล์ data/replays/<event>/r<รอบ>-p<คน>.json
    finish(eventId) {
      if (!round) return;
      const out = path.join(dir, eventId);
      try {
        fs.mkdirSync(out, { recursive: true });
        for (const [slot, r] of Object.entries(rec)) {
          const data = { round: round.no, slot: Number(slot), startedAt: round.startedAt, durationMs: Date.now() - round.startedAt,
            startCode: r.startCode, lang: r.lang, ops: r.ops, events: r.events, pastes: r.pastes, truncated: r.full };
          fs.writeFileSync(path.join(out, `r${round.no}-p${slot}.json`), JSON.stringify(data));
        }
      } catch (e) { console.error('บันทึก replay ไม่สำเร็จ:', e.message); }
      round = null; rec = {};
    },
    cancel() { round = null; rec = {}; },
  };
}

function readReplay(dir, eventId, roundNo, slot) {
  if (!/^[a-z0-9]+$/.test(String(eventId))) return null;
  const f = path.join(dir, String(eventId), `r${Number(roundNo)}-p${Number(slot)}.json`);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; }
}
function deleteReplays(dir, eventId, roundNo) {
  const d = path.join(dir, String(eventId));
  try { for (const f of fs.readdirSync(d)) if (f.startsWith(`r${roundNo}-`)) fs.unlinkSync(path.join(d, f)); } catch (_) {}
}

// ====================================================================
// ความคล้ายของโค้ด
//   ตัดคอมเมนต์ แยกเป็น token แล้วเทียบชุดลำดับ token ยาว K ตัว (k-gram)
//   - "เหมือนตรงตัว"   : เทียบ token ตามจริง
//   - "โครงสร้างเหมือน" : แทนชื่อตัวแปร/ฟังก์ชันทั้งหมดด้วย ID (จับการเปลี่ยนชื่อตัวแปรเพื่อเลี่ยง)
//   ตัด k-gram ที่มาจากโค้ดแม่แบบเริ่มต้นออก เพราะทุกคนเริ่มจากแม่แบบเดียวกัน
// ====================================================================
const K = 5;
const KEYWORDS = new Set(`
  if else elif for while do return break continue def class import from as in not and or is lambda pass None True False
  try except finally raise with yield global nonlocal assert del print input range len int str float list dict set tuple map
  sorted min max sum abs open
  include define using namespace std int long short char bool double float void auto const static unsigned signed struct
  template typename public private protected new delete true false nullptr sizeof switch case default goto
  vector string map set pair queue stack deque priority_queue unordered_map unordered_set cin cout endl
  push_back emplace_back size begin end sort swap make_pair first second
`.split(/\s+/).filter(Boolean));

function tokenize(code, lang) {
  let src = String(code || '');
  src = lang === 'cpp'
    ? src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
    : src.replace(/#[^\n]*/g, ' ');
  const re = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|[A-Za-z_]\w*|\d+(?:\.\d+)?|[^\s\w]/g;
  const exact = [], shape = [];
  for (const m of src.matchAll(re)) {
    const tok = m[0];
    exact.push(tok);
    if (/^["']/.test(tok)) shape.push('S');
    else if (/^[A-Za-z_]/.test(tok)) shape.push(KEYWORDS.has(tok) ? tok : 'ID');
    else if (/^\d/.test(tok)) shape.push('N');
    else shape.push(tok);
  }
  return { exact, shape };
}
const grams = (toks) => {
  const s = new Set();
  for (let i = 0; i + K <= toks.length; i++) s.add(toks.slice(i, i + K).join('\u0001'));
  return s;
};
function jaccard(a, b) {
  if (!a.size || !b.size) return null;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

// rows: [{slot, name, lang, code}], templates: {python, cpp}
function similarity(rows, templates) {
  const tmpl = {};
  for (const lang of ['python', 'cpp']) {
    const t = tokenize(templates[lang], lang);
    tmpl[lang] = { exact: grams(t.exact), shape: grams(t.shape) };
  }
  const prints = rows.map((r) => {
    const t = tokenize(r.code, r.lang);
    const strip = (set, key) => { for (const g of tmpl[r.lang]?.[key] || []) set.delete(g); return set; };
    return { ...r, exact: strip(grams(t.exact), 'exact'), shape: strip(grams(t.shape), 'shape'), tokens: t.exact.length };
  });
  const pairs = [];
  for (let i = 0; i < prints.length; i++) for (let j = i + 1; j < prints.length; j++) {
    const a = prints[i], b = prints[j];
    if (a.lang !== b.lang) continue;                       // ต่างภาษาไม่เทียบ
    if (a.shape.size < 8 || b.shape.size < 8) continue;    // โค้ดสั้นเกินไป เทียบแล้วไม่มีความหมาย
    const shape = jaccard(a.shape, b.shape), exact = jaccard(a.exact, b.exact);
    if (shape == null) continue;
    pairs.push({ a: { slot: a.slot, name: a.name }, b: { slot: b.slot, name: b.name }, lang: a.lang,
      exact: Math.round(exact * 100), shape: Math.round(shape * 100), tokens: [a.tokens, b.tokens] });
  }
  pairs.sort((x, y) => y.shape - x.shape || y.exact - x.exact);
  return pairs;
}

module.exports = { createRecorder, readReplay, deleteReplays, similarity, diffOp };
