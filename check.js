// check.js — ตรวจความพร้อมก่อนวันแข่ง: npm run check
//   รุ่น Node.js (ช่องโหว่ที่ประกาศแล้ว), Docker และ image สำหรับรันโค้ด
const { checkNode } = require('./node-check');
const createSandbox = require('./sandbox');

(async () => {
  let ok = true;
  const n = checkNode();
  console.log(`${n.ok ? '✔' : '✖'} ${n.message}`);
  if (!n.ok) ok = false;
  if (process.argv.includes('--warn')) {          // ตอน npm install: เตือนแต่ไม่หยุด
    if (!n.ok) console.warn('⚠ ติดตั้งต่อได้ แต่ Code Duel จะไม่ยอมเริ่มจนกว่าจะอัปเดต Node.js');
    process.exit(0);
  }
  if (process.argv.includes('--security')) process.exit(ok ? 0 : 1);

  const executor = (process.env.EXECUTOR || 'docker').toLowerCase();
  const sb = createSandbox({ executor, dockerCmd: process.env.DOCKER_CMD || 'docker', image: process.env.RUNNER_IMAGE || 'code-duel-runner:2' });
  const r = await sb.check();
  console.log(`${r.ok ? '✔' : '✖'} ${r.message}`);
  if (!r.ok) ok = false;
  console.log(ok ? '\nพร้อมใช้งาน' : '\nยังไม่พร้อม — แก้รายการที่มี ✖ ก่อน');
  process.exit(ok ? 0 : 1);
})();
