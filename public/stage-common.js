// stage-common.js — ส่วนที่ใช้ร่วมกันของจอผู้ชม (scoreboard / spectator) และหน้าผู้เล่น
(function () {
  // ---------- นาฬิกาให้ตรงกับเซิร์ฟเวอร์ ----------
  let offset = 0;
  const Clock = {
    sync(serverNow) { if (serverNow) offset = serverNow - Date.now(); },
    now: () => Date.now() + offset,
  };

  // ---------- เสียง (สร้างด้วย WebAudio ไม่ต้องมีไฟล์เสียง) ----------
  let ctx = null, enabled = false;
  const Sound = {
    get enabled() { return enabled; },
    enable() {
      try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); enabled = true; } catch (_) { enabled = false; }
      return enabled;
    },
    disable() { enabled = false; },
    tone(freq, dur = 0.12, type = 'sine', gain = 0.18, when = 0) {
      if (!enabled || !ctx) return;
      const t = ctx.currentTime + when;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    },
    tick() { Sound.tone(880, 0.08, 'square', 0.08); },
    go() { Sound.tone(523, 0.12, 'triangle'); Sound.tone(784, 0.25, 'triangle', 0.2, 0.1); },
    ok() { Sound.tone(660, 0.1, 'triangle'); Sound.tone(990, 0.18, 'triangle', 0.18, 0.09); },
    fail() { Sound.tone(220, 0.18, 'sawtooth', 0.07); },
    fanfare() { [523, 659, 784, 1047].forEach((f, i) => Sound.tone(f, i === 3 ? 0.45 : 0.14, 'triangle', 0.2, i * 0.11)); },
    reveal() { Sound.tone(440, 0.08, 'triangle', 0.12); Sound.tone(660, 0.14, 'triangle', 0.14, 0.07); },
    end() { Sound.tone(392, 0.2, 'triangle'); Sound.tone(294, 0.4, 'triangle', 0.18, 0.18); },
  };

  // ---------- ข้อความข่าวด่วน ----------
  const fmtTime = (ms) => {
    if (ms == null) return '-';
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  };
  function feedText(e) {
    switch (e.type) {
      case 'start': return ['🚦', `เริ่มรอบที่ ${e.round}: ${e.title}`];
      case 'submit': return ['📤', `${e.name} ส่งคำตอบ ผ่าน ${e.passed}/${e.total}`];
      case 'ac': return ['✅', `${e.name} ผ่านครบ ${e.passed}/${e.total}!`];
      case 'firstblood': return ['🩸', `FIRST BLOOD — ${e.name} ผ่านครบเป็นคนแรก (${fmtTime(e.elapsedMs)})`];
      case 'lead': return ['👑', `${e.name} ขึ้นนำ!`];
      case 'pending': return ['🔒', `${e.name} ส่งคำตอบ (ผลถูกซ่อน)`];
      case 'warn': return ['⏰', `เหลือเวลา ${e.minutes} นาที`];
      case 'freeze': return ['🧊', `ตารางคะแนนถูกแช่แข็ง ${e.minutes} นาทีสุดท้าย`];
      case 'end': return ['🏁', e.frozen ? 'หมดเวลา! รอประกาศผล' : 'หมดเวลา!'];
      case 'revealed': return ['🏆', 'ประกาศผลครบแล้ว'];
      default: return ['•', e.type];
    }
  }
  const feedClass = (e) => ({ ac: 'good', firstblood: 'gold', lead: 'gold', pending: 'muted', warn: 'warn', freeze: 'cold', end: 'warn', revealed: 'gold' })[e.type] || '';

  // ---------- ตารางคะแนนแบบมีแอนิเมชันเมื่ออันดับขยับ ----------
  const COLORS = ['#f2b84b', '#6cb6ff', '#5fd08f', '#ff8fa3', '#b69cff', '#4fd1c5', '#ff9f5a', '#e2e86c'];
  const colorOf = (slot) => COLORS[(slot - 1) % COLORS.length];

  function renderBoard(tbody, rows, opts = {}) {
    const before = new Map([...tbody.children].map((tr) => [tr.dataset.slot, tr.getBoundingClientRect().top]));
    const existing = new Map([...tbody.children].map((tr) => [tr.dataset.slot, tr]));
    const frag = [];
    for (const r of rows) {
      let tr = existing.get(String(r.slot));
      if (!tr) {
        tr = document.createElement('tr'); tr.dataset.slot = r.slot;
        tr.innerHTML = '<td class="rk"></td><td class="nm"><span class="sw"></span><span class="nt"></span></td><td class="pr"><div class="bar"></div></td><td class="pt"></td><td class="tm"></td><td class="sb"></td>';
        tr.querySelector('.sw').style.background = colorOf(r.slot);
      }
      existing.delete(String(r.slot));
      tr.querySelector('.rk').textContent = r.rank;
      tr.querySelector('.nt').textContent = r.name;
      const bar = tr.querySelector('.bar');
      const total = Math.max(1, r.total || opts.testCount || 1);
      if (bar.childElementCount !== total) bar.replaceChildren(...Array.from({ length: total }, () => document.createElement('i')));
      [...bar.children].forEach((seg, i) => seg.classList.toggle('on', i < r.passed));
      tr.querySelector('.pt').textContent = r.points ?? 0;
      tr.querySelector('.tm').textContent = fmtTime(r.timeMs);
      const sb = tr.querySelector('.sb');
      sb.replaceChildren(String(r.submissions ?? 0));
      if (r.pending) { const q = document.createElement('span'); q.className = 'pend'; q.textContent = ` +${r.pending}?`; q.title = 'ส่งหลังแช่แข็ง ผลยังไม่เปิด'; sb.appendChild(q); }
      tr.className = [r.rank === 1 && r.passed > 0 ? 'lead' : '', r.total && r.passed === r.total ? 'full' : '', r.pending ? 'pending' : ''].join(' ');
      frag.push(tr);
    }
    for (const tr of existing.values()) tr.remove();
    frag.forEach((tr) => tbody.appendChild(tr));
    // FLIP: ย้ายจากตำแหน่งเดิมไปตำแหน่งใหม่อย่างนุ่มนวล
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const tr of frag) {
      const prev = before.get(tr.dataset.slot);
      if (prev == null) continue;
      const dy = prev - tr.getBoundingClientRect().top;
      if (!dy) continue;
      tr.style.transform = `translateY(${dy}px)`; tr.style.transition = 'none';
      requestAnimationFrame(() => { tr.style.transition = 'transform .6s cubic-bezier(.2,.8,.2,1)'; tr.style.transform = ''; });
    }
  }
  function flashRow(tbody, slot, cls = 'flash') {
    const tr = tbody.querySelector(`tr[data-slot="${slot}"]`);
    if (!tr) return;
    tr.classList.remove(cls); void tr.offsetWidth; tr.classList.add(cls);
  }

  // ---------- นับถอยหลังและป้ายประกาศเต็มจอ ----------
  let cdTimer = null;
  function countdown(el, startedAt, onTick) {
    clearInterval(cdTimer);
    let last = null;
    const step = () => {
      const left = startedAt - Clock.now();
      if (left <= -900) { el.hidden = true; clearInterval(cdTimer); return; }
      el.hidden = false;
      const n = left > 0 ? Math.ceil(left / 1000) : 0;
      const label = n > 0 ? String(Math.min(n, 3)) : 'เริ่ม!';
      if (label !== last) { last = label; el.textContent = label; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); onTick?.(n); }
    };
    step(); cdTimer = setInterval(step, 100);
  }
  function banner(el, html, ms = 4000) {
    el.replaceChildren(...html);
    el.hidden = false; el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
    clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  window.Stage = { Clock, Sound, fmtTime, feedText, feedClass, renderBoard, flashRow, countdown, banner, colorOf };
})();
