// stage.js — จอสำหรับผู้ชม
//   📊 Scoreboard (/scoreboard.html)  เปิดได้ทุกคน: อันดับ คะแนน ข่าวด่วน — ไม่มีโค้ด
//   🎥 Spectator  (/spectator.html)   ต้องมีคีย์ผู้ชม: ทุกอย่างข้างบน + จอโค้ด (ซ่อน / หน่วงเวลา / สด) + Spotlight
// ข้อมูลที่ส่งออกจากไฟล์นี้ไม่มีเทสเคสลับและรหัสเข้าใช้
const crypto = require('crypto');

const DEFAULTS = { codeMode: 'hidden', delayMin: 5, freezeMin: 10, countdown: true, spotlight: null };
const FEED_MAX = 40;

module.exports = function createStage(deps) {
  const { io, getEvent, saveEvent, getMatch, currentRound, rawRows, playerInfo, codeNow, codeAt } = deps;

  let feed = [];              // ข่าวด่วนล่าสุด
  let frozen = null;          // { at, rows } ตารางที่ถูกแช่แข็ง
  let pending = {};           // slot -> จำนวนครั้งที่ส่งหลังแช่แข็ง (ผลยังไม่เปิด)
  let reveal = null;          // { order, i, final, done }
  let firstBlood = null;
  let leader = null;
  let timers = [];
  let boardTimer = null;
  let codeTimer = null;
  const lastCodeSent = {};    // กันส่งโค้ดซ้ำ
  let onRevealDone = () => {};

  const settings = () => {
    const ev = getEvent();
    ev.stage = { ...DEFAULTS, ...(ev.stage || {}) };
    if (!ev.stage.key) { ev.stage.key = crypto.randomBytes(6).toString('base64url'); saveEvent(); }
    return ev.stage;
  };
  const now = () => Date.now();

  // ---------- ตาราง ----------
  const strip = (r) => ({ slot: r.slot, name: r.name, passed: r.passed, total: r.total, timeMs: r.timeMs, submissions: r.submissions, rank: r.rank, points: r.points });
  // แสดงเฉพาะคนที่เคยเข้าระบบ/มีชื่อ/เคยส่ง ไม่ให้ที่นั่งว่างรกตาราง
  const visible = (rows) => rows.filter((r) => r.named || r.submissions > 0);
  function rerank(rows) {
    rows.sort((a, b) => b.passed - a.passed || (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity) || a.submissions - b.submissions || a.slot - b.slot);
    rows.forEach((r, i) => { const p = rows[i - 1]; r.rank = p && p.passed === r.passed && p.timeMs === r.timeMs ? p.rank : i + 1; });
    return rows;
  }
  const liveBoard = () => visible(rawRows()).map(strip);
  function boardRows() {
    if (reveal) {
      const shown = new Set(reveal.order.slice(0, reveal.i));
      const rows = frozen.rows.map((r) => (shown.has(r.slot) ? { ...reveal.final[r.slot], revealed: true } : { ...r, pending: pending[r.slot] || 0 }));
      return rerank(rows);
    }
    if (frozen) return frozen.rows.map((r) => ({ ...r, pending: pending[r.slot] || 0 }));
    return liveBoard();
  }
  function board() {
    const m = getMatch();
    const ev = getEvent();
    const round = currentRound();
    const st = settings();
    const started = m.status !== 'waiting' && now() >= (m.startedAt || 0);
    return {
      eventName: ev.name,
      match: { status: m.status, startedAt: m.startedAt, durationMin: m.durationMin, round: m.round, serverNow: now() },
      title: started && round ? round.title : null,
      testCount: round?.testCount ?? 0,
      rows: boardRows(),
      frozen: !!frozen, freezeMin: st.freezeMin,
      reveal: reveal ? { i: reveal.i, total: reveal.order.length, done: reveal.done } : null,
      firstBlood, feed,
    };
  }
  function emitBoard() {             // รวมการอัปเดตที่เกิดติด ๆ กันเป็นครั้งเดียว
    if (boardTimer) return;
    boardTimer = setTimeout(() => { boardTimer = null; io.to('public').emit('stage:board', board()); }, 250);
  }
  function push(item) {
    const e = { ...item, at: now() };
    feed = [e, ...feed].slice(0, FEED_MAX);
    io.to('public').emit('stage:event', e);
    emitBoard();
  }

  // ---------- จอโค้ดสำหรับ Spectator ----------
  function cards() {
    const st = settings();
    const m = getMatch();
    return liveBoard().map((r) => {
      const info = playerInfo(r.slot);
      const card = { slot: r.slot, name: r.name, lang: info.lang, lines: info.lines, lastActive: info.lastActive, running: info.running, judging: info.judging, connected: info.connected };
      card.code = codeFor(r.slot, st, m);
      return card;
    });
  }
  function codeFor(slot, st, m) {
    if (m.status !== 'running') return st.codeMode === 'hidden' && m.status === 'waiting' ? null : codeNow(slot); // จบรอบแล้วเปิดโค้ดได้
    if (st.codeMode === 'live') return codeNow(slot);
    if (st.codeMode === 'delayed') {
      const t = now() - m.startedAt - st.delayMin * 60000;
      if (t < 0) return { code: '', lang: playerInfo(slot).lang, waiting: Math.ceil(-t / 1000) };
      return codeAt(slot, t);
    }
    return null;
  }
  function spectatorState() { return { ...board(), settings: publicSettings(), cards: cards() }; }
  const publicSettings = () => { const st = settings(); return { codeMode: st.codeMode, delayMin: st.delayMin, spotlight: st.spotlight }; };
  function emitSpectators() { io.to('spectators').emit('stage:spectator', spectatorState()); }

  // โหมดหน่วงเวลา: ส่งโค้ดทุก 2 วินาที / โหมดอื่นส่งเมื่อมีการพิมพ์
  function startCodeLoop() {
    clearInterval(codeTimer);
    codeTimer = setInterval(() => {
      const st = settings(), m = getMatch();
      if (st.codeMode !== 'delayed' || m.status !== 'running') return;
      for (const r of liveBoard()) {
        const c = codeFor(r.slot, st, m);
        const key = c ? c.lang + '\u0000' + c.code + (c.waiting ?? '') : '';
        if (lastCodeSent[r.slot] === key) continue;
        lastCodeSent[r.slot] = key;
        io.to('spectators').emit('stage:code', { slot: r.slot, ...c });
      }
    }, 2000);
  }
  startCodeLoop();

  // ---------- เหตุการณ์จากเซิร์ฟเวอร์ ----------
  const api = {
    settings, board,
    isFrozen: () => !!frozen,
    onRevealDone(fn) { onRevealDone = fn; },

    roundStart(round, startedAt, durationMs) {
      timers.forEach(clearTimeout); timers = [];
      frozen = null; pending = {}; reveal = null; firstBlood = null; leader = null;
      for (const k of Object.keys(lastCodeSent)) delete lastCodeSent[k];
      feed = [];
      const st = settings();
      const at = (ms, fn, evenIfPast = false) => {
        const d = startedAt + ms - now();
        if (d > 0 || evenIfPast) timers.push(setTimeout(fn, Math.max(0, d)));
      };
      at(0, () => push({ type: 'start', round: round.no, title: round.title }), true);
      if (st.freezeMin > 0 && st.freezeMin * 60000 < durationMs) {
        at(durationMs - st.freezeMin * 60000, () => {
          frozen = { at: now(), rows: liveBoard().map((r) => ({ ...r })) };
          push({ type: 'freeze', minutes: st.freezeMin });
          io.to('admins').emit('stage:admin', api.adminState());
        });
      }
      for (const min of [5, 1]) if (durationMs > min * 60000 + 30000) at(durationMs - min * 60000, () => push({ type: 'warn', minutes: min }));
      emitBoard(); emitSpectators();
    },

    submit(slot, name, passed, total) {
      if (frozen) {
        pending[slot] = (pending[slot] || 0) + 1;
        push({ type: 'pending', slot, name });
        return;
      }
      const full = total > 0 && passed === total;
      push({ type: full ? 'ac' : 'submit', slot, name, passed, total });
      if (full && !firstBlood) {
        const m = getMatch();
        firstBlood = { slot, name, elapsedMs: now() - m.startedAt };
        push({ type: 'firstblood', slot, name, elapsedMs: firstBlood.elapsedMs });
        io.to('public').emit('stage:firstblood', firstBlood);
      }
      const top = liveBoard()[0];
      if (top && top.passed > 0 && top.slot !== leader) {
        if (leader != null) push({ type: 'lead', slot: top.slot, name: top.name });
        leader = top.slot;
      }
    },

    code(slot) {
      const st = settings();
      if (st.codeMode === 'live' && getMatch().status === 'running') {
        const c = codeNow(slot);
        io.to('spectators').emit('stage:code', { slot, ...c });
      }
      const info = playerInfo(slot);
      io.to('spectators').emit('stage:activity', { slot, lines: info.lines, lastActive: info.lastActive, running: info.running, judging: info.judging, lang: info.lang });
    },
    busy(slot) { api.code(slot); },
    roster() { emitBoard(); emitSpectators(); },

    roundEnd(round) {
      timers.forEach(clearTimeout); timers = [];
      push({ type: 'end', round: round.no, frozen: !!frozen });
      if (frozen) {
        // เตรียมประกาศผล: เปิดจากอันดับล่างขึ้นบน (ตามอันดับตอนแช่แข็ง)
        const final = {};
        for (const r of visible(round.results.map((x) => ({ ...x, named: true })))) final[r.slot] = strip(r);
        for (const r of frozen.rows) if (!final[r.slot]) final[r.slot] = { ...r };
        const order = [...frozen.rows].sort((a, b) => b.rank - a.rank || b.slot - a.slot).map((r) => r.slot);
        reveal = { order, i: 0, final, done: false };
      }
      emitBoard(); emitSpectators();
      io.to('admins').emit('stage:admin', api.adminState());
    },
    roundReset() {
      timers.forEach(clearTimeout); timers = [];
      if (reveal && !reveal.done) finishReveal();
      frozen = null; pending = {}; reveal = null; firstBlood = null; leader = null; feed = [];
      emitBoard(); emitSpectators();
      io.to('admins').emit('stage:admin', api.adminState());
    },

    // ---------- ประกาศผลทีละคน ----------
    revealNext(all) {
      if (!reveal || reveal.done) return;
      const step = () => {
        const slot = reveal.order[reveal.i];
        const before = boardRows().find((r) => r.slot === slot);
        reveal.i += 1;
        const after = boardRows().find((r) => r.slot === slot);
        io.to('public').emit('stage:reveal', { slot, name: after?.name, before, after, i: reveal.i, total: reveal.order.length });
      };
      if (all) while (reveal.i < reveal.order.length) step(); else step();
      if (reveal.i >= reveal.order.length) finishReveal();
      emitBoard(); emitSpectators();
      io.to('admins').emit('stage:admin', api.adminState());
    },

    adminState() {
      const st = settings();
      return {
        settings: { codeMode: st.codeMode, delayMin: st.delayMin, freezeMin: st.freezeMin, countdown: st.countdown, spotlight: st.spotlight },
        key: st.key, frozen: !!frozen,
        reveal: reveal ? { i: reveal.i, total: reveal.order.length, done: reveal.done, next: reveal.order[reveal.i] ?? null } : null,
      };
    },
    setSettings(p = {}) {
      const st = settings();
      if (['hidden', 'delayed', 'live'].includes(p.codeMode)) st.codeMode = p.codeMode;
      if (p.delayMin != null) st.delayMin = Math.max(1, Math.min(60, Math.round(Number(p.delayMin)) || 5));
      if (p.freezeMin != null) st.freezeMin = Math.max(0, Math.min(120, Math.round(Number(p.freezeMin)) || 0));
      if (p.countdown != null) st.countdown = !!p.countdown;
      if ('spotlight' in p) st.spotlight = p.spotlight == null || p.spotlight === '' ? null : Number(p.spotlight);
      for (const k of Object.keys(lastCodeSent)) delete lastCodeSent[k];
      saveEvent();
      emitSpectators();
      io.to('admins').emit('stage:admin', api.adminState());
    },
    rotateKey() {
      settings().key = crypto.randomBytes(6).toString('base64url');
      saveEvent();
      // คนที่ดูด้วยคีย์เดิมถูกตัดออก
      for (const s of io.sockets.adapter.rooms.get('spectators') || []) {
        const sock = io.sockets.sockets.get(s);
        if (sock) { sock.leave('spectators'); sock.emit('stage:kicked'); }
      }
      io.to('admins').emit('stage:admin', api.adminState());
    },

    // ---------- เข้าดู ----------
    joinScoreboard(socket, cb) { socket.join('public'); cb({ ok: true, board: board() }); },
    joinSpectator(socket, key, cb) {
      if (!key || key !== settings().key) return cb({ ok: false, error: 'คีย์ผู้ชมไม่ถูกต้อง — ขอลิงก์ใหม่จากผู้ดูแล' });
      socket.join('public'); socket.join('spectators');
      cb({ ok: true, state: spectatorState() });
    },
    reset() { feed = []; frozen = null; pending = {}; reveal = null; firstBlood = null; leader = null; emitBoard(); emitSpectators(); },
  };

  function finishReveal() {
    reveal.done = true;
    frozen = null; pending = {};
    push({ type: 'revealed' });
    onRevealDone();
    reveal = null;
  }

  return api;
};
