// sandbox.js — ที่รันโค้ดของผู้เล่น
//   docker : รันในคอนเทนเนอร์แยก ไม่มีเครือข่าย จำกัด CPU / RAM / จำนวนโปรเซส อ่านไฟล์ในเครื่องเซิร์ฟเวอร์ไม่ได้ (ค่าเริ่มต้นของ v2)
//   local  : รันบนเครื่องเซิร์ฟเวอร์โดยตรงแบบ v1 (ไม่ปลอดภัย ใช้เมื่อไม่มี Docker และไว้ใจผู้เล่นทุกคน)
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LABEL = 'code-duel=1';

// เรียกคำสั่งให้จบแล้วคืนผล (ใช้กับคำสั่งสั้น ๆ เช่น docker rm)
function runCmd(cmd, args, { input, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try { child = spawn(cmd, args); } catch (e) { return resolve({ code: -1, out, err: e.message }); }
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {});
    child.on('error', (e) => finish({ code: -1, out, err: e.message }));
    child.on('close', (code) => finish({ code, out, err }));
    child.stdin.end(input ?? '');
  });
}

// รันหนึ่งเทสเคส: ส่ง input เข้า เก็บ output จำกัดขนาด และวัดเวลา
function collect(child, input, { maxOut, hardKillMs, onTimeout }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '', ole = false, killed = false, done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve({ ...r, out, ole, killed, ms: Date.now() - t0 }); } };
    const t = setTimeout(() => { killed = true; onTimeout?.(); try { child.kill('SIGKILL'); } catch (_) {} }, hardKillMs);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > maxOut) { ole = true; try { child.kill('SIGKILL'); } catch (_) {} }
    });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => finish({ code: -1 }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin.end(input);
  });
}

// ====================================================================
// โหมด docker
// ====================================================================
function dockerSandbox(cfg) {
  const D = cfg.dockerCmd;
  const sec = (ms) => String(Math.max(1, Math.ceil(ms / 1000)));

  async function check() {
    const v = await runCmd(D, ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 15000 });
    if (v.code !== 0) {
      return { ok: false, message: 'เชื่อมต่อ Docker ไม่ได้ — เปิด Docker Desktop (หรือ dockerd) ก่อน แล้วรันใหม่\n  ' + (v.err.trim() || 'ไม่พบคำสั่ง docker') };
    }
    const img = await runCmd(D, ['image', 'inspect', cfg.image], { timeoutMs: 15000 });
    if (img.code !== 0) {
      return { ok: false, message: `ยังไม่มี image ${cfg.image} — รัน "npm run build-runner" หนึ่งครั้งก่อน (ต้องใช้อินเทอร์เน็ต)` };
    }
    return { ok: true, message: `Docker ${v.out.trim()} — image ${cfg.image}` };
  }

  // ลบคอนเทนเนอร์ที่ค้างจากการรันครั้งก่อน (เช่น เซิร์ฟเวอร์ถูกปิดกะทันหัน)
  async function cleanupAll() {
    const ps = await runCmd(D, ['ps', '-aq', '--filter', `label=${LABEL}`]);
    const ids = ps.out.split(/\s+/).filter(Boolean);
    if (ids.length) await runCmd(D, ['rm', '-f', ...ids]);
    return ids.length;
  }

  async function open(slot, purpose) {
    const name = `codeduel-p${slot}-${purpose}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const children = new Set();
    let destroyed = false, started = false, lang = 'python';

    const args = [
      'run', '-d', '--rm', '--name', name, '--label', LABEL,
      '--network', 'none',                          // ไม่มีอินเทอร์เน็ต/วงแลน
      '--memory', cfg.memory, '--memory-swap', cfg.memory,
      '--cpus', String(cfg.cpus),
      '--pids-limit', String(cfg.pids),             // กัน fork bomb
      '--read-only',                                // ระบบไฟล์ของคอนเทนเนอร์เขียนไม่ได้
      '--tmpfs', `/work:rw,exec,nosuid,size=${cfg.workSize},uid=10001,gid=10001,mode=700`,
      '--tmpfs', '/tmp:rw,nosuid,size=16m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '10001:10001', '-w', '/work',
      '-e', 'PYTHONDONTWRITEBYTECODE=1',
      cfg.image, 'sleep', String(cfg.lifetimeSec),  // คอนเทนเนอร์ลบตัวเองเมื่อครบเวลา แม้เซิร์ฟเวอร์ล่ม
    ];
    const r = await runCmd(D, args, { timeoutMs: 60000 });
    if (r.code !== 0) throw new Error('สร้างคอนเทนเนอร์ไม่สำเร็จ: ' + (r.err.trim() || r.out.trim()));
    started = true;

    const execArgs = (interactive, timeoutMs, cmd) =>
      ['exec', ...(interactive ? ['-i'] : []), name, 'timeout', '-s', 'KILL', sec(timeoutMs), ...cmd];
    const track = (child) => { children.add(child); child.on('close', () => children.delete(child)); return child; };
    const runCommand = () => (lang === 'cpp' ? ['/work/main'] : ['python3', '-u', '/work/main.py']);
    const clean = (s) => s.replaceAll('/work/', '');

    const session = {
      mode: 'docker',
      get destroyed() { return destroyed; },

      async prepare(language, code, compileTimeoutMs) {
        lang = language;
        const file = lang === 'cpp' ? 'main.cpp' : 'main.py';
        const w = await runCmd(D, ['exec', '-i', name, 'sh', '-c', `cat > /work/${file}`], { input: code });
        if (w.code !== 0) return { ok: false, output: 'เขียนไฟล์ในคอนเทนเนอร์ไม่สำเร็จ: ' + w.err };
        if (lang !== 'cpp') return { ok: true, output: '' };
        const c = await runCmd(D, execArgs(false, compileTimeoutMs,
          ['g++', `-std=${cfg.cxxStd}`, '-O2', '-pipe', '-o', '/work/main', '/work/main.cpp']), { timeoutMs: compileTimeoutMs + 10000 });
        const output = clean(c.err + c.out);
        if (c.code === 137) return { ok: false, output: output + `\nคอมไพล์นานเกิน ${sec(compileTimeoutMs)} วินาที หรือใช้หน่วยความจำเกิน` };
        return { ok: c.code === 0, output };
      },

      // โหมดรันโค้ดแบบโต้ตอบ
      spawnInteractive(timeoutMs) {
        return track(spawn(D, execArgs(true, timeoutMs, runCommand())));
      },
      cleanError: clean,

      // รันหนึ่งเทสเคส
      async runTest(input, limitMs, maxOut) {
        const child = track(spawn(D, execArgs(true, limitMs, runCommand())));
        const r = await collect(child, input, { maxOut, hardKillMs: limitMs + 8000 });
        // timeout ภายในคอนเทนเนอร์ฆ่าด้วย SIGKILL → exit 137 ทั้งกรณีเกินเวลาและหน่วยความจำเกิน แยกด้วยเวลาที่ใช้
        const tle = r.killed || (r.code === 137 && r.ms >= limitMs);
        const mle = !tle && r.code === 137;
        return { code: r.code, out: r.out, ms: r.ms, tle, ole: r.ole, mle };
      },

      async destroy() {
        if (destroyed) return;
        destroyed = true;
        // ลบคอนเทนเนอร์ก่อน (ฆ่าทุกโปรเซสข้างใน) แล้วค่อยปิดคำสั่ง docker exec ที่ค้างอยู่
        if (started) await runCmd(D, ['rm', '-f', name]);
        for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} }
      },
    };
    return session;
  }

  return { mode: 'docker', check, open, cleanupAll };
}

// ====================================================================
// โหมด local (แบบ v1)
// ====================================================================
function localSandbox(cfg) {
  const base = path.join(os.tmpdir(), 'code-duel');
  async function check() {
    return { ok: true, message: '⚠ รันโค้ดบนเครื่องนี้โดยตรง (ไม่มีการแยกสภาพแวดล้อม)' };
  }
  async function cleanupAll() { return 0; }

  async function open(slot, purpose) {
    const dir = path.join(base, `p${slot}`, purpose);
    fs.mkdirSync(dir, { recursive: true });
    const children = new Set();
    let destroyed = false, cmd = null;
    const track = (child) => { children.add(child); child.on('close', () => children.delete(child)); return child; };
    const clean = (s) => s.replaceAll(dir + path.sep, '');

    return {
      mode: 'local',
      get destroyed() { return destroyed; },

      async prepare(lang, code, compileTimeoutMs) {
        if (lang === 'cpp') {
          const src = path.join(dir, 'main.cpp');
          const exe = path.join(dir, process.platform === 'win32' ? 'main.exe' : 'main');
          fs.writeFileSync(src, code);
          try { fs.unlinkSync(exe); } catch (_) {}
          const c = await runCmd(cfg.cxxCmd, [`-std=${cfg.cxxStd}`, '-O2', '-o', exe, src], { timeoutMs: compileTimeoutMs });
          cmd = [exe];
          const output = clean(c.err).replaceAll(src, 'main.cpp');
          return { ok: c.code === 0, output: c.code === -1 ? `เรียกคอมไพเลอร์ไม่ได้: ${c.err}` : output };
        }
        const src = path.join(dir, 'main.py');
        fs.writeFileSync(src, code);
        cmd = [cfg.pythonCmd, '-u', src];
        return { ok: true, output: '' };
      },

      spawnInteractive(timeoutMs) {
        const child = track(spawn(cmd[0], cmd.slice(1), { cwd: dir }));
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
        child.on('close', () => clearTimeout(t));
        return child;
      },
      cleanError: clean,

      async runTest(input, limitMs, maxOut) {
        const child = track(spawn(cmd[0], cmd.slice(1), { cwd: dir }));
        const r = await collect(child, input, { maxOut, hardKillMs: limitMs });
        return { code: r.code, out: r.out, ms: r.ms, tle: r.killed, ole: r.ole, mle: false };
      },

      async destroy() {
        destroyed = true;
        for (const c of children) { try { c.kill('SIGKILL'); } catch (_) {} }
      },
    };
  }

  return { mode: 'local', check, open, cleanupAll };
}

module.exports = function createSandbox(cfg) {
  cfg = { cxxStd: 'gnu++20', ...cfg };
  return cfg.executor === 'local' ? localSandbox(cfg) : dockerSandbox(cfg);
};
