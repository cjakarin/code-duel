// คัดลอกข้อความ: navigator.clipboard ใช้ได้เฉพาะ https/localhost
// เมื่อเปิดผ่าน IP ในวงแลน (http) ต้องใช้วิธีสำรอง
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(() => true, () => false);
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) {}
  ta.remove();
  return Promise.resolve(ok);
}

// แสดงโจทย์จาก markdown (ใช้ร่วมกันทั้งหน้าผู้เล่นและหน้าตัวอย่างของผู้ดูแล)
// onRun(input) = ฟังก์ชันเมื่อกด "รันตัวอย่างนี้" (ไม่ส่งมา = ไม่แสดงปุ่ม)
// ---------- สูตรคณิตศาสตร์ ----------
// $...$ = สูตรในบรรทัด, $$...$$ = สูตรแยกบรรทัด, \$ = เครื่องหมายดอลลาร์ธรรมดา
// สูตรถูกดึงออกก่อนแปลง Markdown (กัน _ กับ * ในสูตรกลายเป็นตัวเอียง) แล้วใส่กลับหลังกรอง HTML
function extractMath(md) {
  const math = [];
  const DOLLAR = '\u0000D\u0000';
  let src = md.replace(/\\\$/g, DOLLAR);
  // ข้ามโค้ด (```...``` และ `...`) ไม่แปลงสูตรในนั้น
  src = src.replace(/(```[\s\S]*?```|`[^`\n]*`)|\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (m, code, block, inline) => {
    if (code) return code;
    math.push({ tex: block ?? inline, display: block != null });
    return `@@MATH${math.length - 1}@@`;
  });
  return { src: src.replaceAll(DOLLAR, '$'), math };
}
function renderMath(tex, display) {
  if (typeof katex === 'undefined') return null;
  // trust: false = ไม่อนุญาตคำสั่งที่สร้างลิงก์/HTML จึงปลอดภัยที่จะใส่ผลลัพธ์ลงหน้าโดยตรง
  return katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false, output: 'htmlAndMathml' });
}
function injectMath(html, math) {
  return html.replace(/@@MATH(\d+)@@/g, (m, i) => {
    const item = math[Number(i)];
    if (!item) return m;
    const out = renderMath(item.tex, item.display);
    if (out == null) return (item.display ? '$$' : '$') + item.tex.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]) + (item.display ? '$$' : '$');
    return item.display ? `<span class="math-block">${out}</span>` : out; // span: สูตรแยกบรรทัดอาจอยู่ในย่อหน้าเดียวกับข้อความ
  });
}

function renderProblem(container, problem, onRun) {
  const { src, math } = extractMath(problem.markdown || '');
  const html = marked.parse(src, { gfm: true, breaks: false });
  container.innerHTML = injectMath(DOMPurify.sanitize(html), math);
  container.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });

  container.querySelectorAll('.example[data-i]').forEach((box) => {
    const i = Number(box.dataset.i);
    const ex = problem.examples[i];
    if (!ex) return box.remove();
    box.replaceChildren();

    const head = document.createElement('div');
    head.className = 'ex-head';
    head.textContent = `ตัวอย่างที่ ${i + 1}`;
    if (onRun) {
      const b = document.createElement('button');
      b.className = 'btn ghost small run-ex';
      b.textContent = 'รันตัวอย่างนี้';
      b.onclick = () => onRun(ex.input);
      head.appendChild(b);
    }
    box.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'ex-grid';
    for (const [label, text] of [['ข้อมูลนำเข้า', ex.input], ['ข้อมูลส่งออก', ex.output]]) {
      const col = document.createElement('div');
      const cap = document.createElement('div');
      cap.className = 'ex-cap';
      cap.textContent = label;
      const copy = document.createElement('button');
      copy.className = 'btn ghost small';
      copy.textContent = 'คัดลอก';
      copy.onclick = async () => {
        copy.textContent = (await copyText(text)) ? 'คัดลอกแล้ว' : 'คัดลอกไม่ได้';
        setTimeout(() => (copy.textContent = 'คัดลอก'), 1200);
      };
      cap.appendChild(copy);
      const pre = document.createElement('pre');
      pre.textContent = text;
      col.append(cap, pre);
      grid.appendChild(col);
    }
    box.appendChild(grid);
  });

  const meta = document.createElement('p');
  meta.className = 'pmeta';
  meta.textContent = `จำกัดเวลา ${problem.timeLimit} วินาทีต่อเทสเคส — ตรวจด้วยเทสเคสลับ ${problem.testCount} ชุด`;
  container.appendChild(meta);
}
