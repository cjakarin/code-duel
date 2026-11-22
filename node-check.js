// node-check.js — ตรวจว่า Node.js ที่ใช้รันเป็นรุ่นที่แก้ช่องโหว่แล้ว
// ปรับตารางนี้เมื่อมีประกาศความปลอดภัยใหม่ (ดู https://nodejs.org/en/blog/vulnerability)
// อ้างอิง: ประกาศ ThaiCERT / Node.js security release 21 ต.ค. 2569 (CVE-2026-105481 … CVE-2026-111497)
const MIN_SAFE = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' };
const MIN_MAJOR = 22;
const UPDATED = '21 ต.ค. 2569';

function cmp(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

// level: ok | vulnerable | eol | unsupported | unknown
function checkNode(version = process.versions.node) {
  const major = Number(version.split('.')[0]);
  const base = { version, major, minSafe: MIN_SAFE[major] || null, updated: UPDATED };
  if (major < MIN_MAJOR) {
    return { ...base, ok: false, level: 'unsupported', message: `Node.js ${version} เก่าเกินไป Code Duel ต้องใช้ ${MIN_MAJOR} ขึ้นไป (แนะนำรุ่น LTS ล่าสุด)` };
  }
  if (MIN_SAFE[major]) {
    if (cmp(version, MIN_SAFE[major]) < 0) {
      return { ...base, ok: false, level: 'vulnerable', message: `Node.js ${version} มีช่องโหว่ความปลอดภัยที่ประกาศแล้ว ต้องอัปเดตเป็น ${MIN_SAFE[major]} ขึ้นไป` };
    }
    return { ...base, ok: true, level: 'ok', message: `Node.js ${version} — แก้ช่องโหว่ตามประกาศ ${UPDATED} แล้ว` };
  }
  if (major % 2 === 1 && major < 27) {
    // สายเลขคี่ (23, 25) ไม่ใช่ LTS และหมดการสนับสนุนแล้ว ไม่ได้รับแพตช์ความปลอดภัย
    return { ...base, ok: false, level: 'eol', message: `Node.js ${version} หมดการสนับสนุนแล้ว ไม่ได้รับแพตช์ความปลอดภัย เปลี่ยนเป็นรุ่น LTS` };
  }
  return { ...base, ok: true, level: 'unknown', message: `Node.js ${version} ใหม่กว่าตารางที่ระบบรู้จัก (${UPDATED}) ตรวจประกาศล่าสุดที่ nodejs.org` };
}

module.exports = { checkNode, MIN_SAFE, cmp };
