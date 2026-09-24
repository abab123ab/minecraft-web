// 一次跑完所有带断言的套件，最后打一张总表。用法：node tools/runall.mjs
// 浏览器套件靠 127.0.0.1:8321 上的静态服务器取文件，跑之前先把 serve.mjs 起着。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  ['minetest.mjs', '挖掘/掉落逻辑'],
  ['oredist.mjs', '矿层与基岩'],
  ['minebrowser.mjs', '挖掘端到端'],
  ['lighttest.mjs', '光照逻辑'],
  ['lightprop.mjs', '光照传播'],
  ['meshlighttest.mjs', '光照渲染'],
  ['mobtest.mjs', '生物回归'],
  ['mobopttest.mjs', '生物优化'],
  ['textest.mjs', '贴图与颜色'],
  ['orechaintest.mjs', '连锁挖矿'],
  ['invtest.mjs', '背包'],
  ['layouttest.mjs', 'HUD 布局'],
  ['bedtest.mjs', '床与睡觉'],
  ['soundtest.mjs', '音效']
];

function run(file) {
  return new Promise((resolve) => {
    const t = Date.now();
    const p = spawn(process.execPath, [path.join(ROOT, 'tools', file)], { cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      // 结论行就是“通过 N/M”，取最后一条匹配
      const m = [...out.matchAll(/通过\s*(\d+)\s*\/\s*(\d+)/g)].pop();
      const bad = out.split('\n').filter((l) => /FAIL|ERROR|Error:/.test(l)).slice(0, 4);
      resolve({ pass: m ? +m[1] : 0, total: m ? +m[2] : 0, found: !!m, code, ms: Date.now() - t, bad });
    });
  });
}

console.log('共 ' + SUITES.length + ' 个套件\n');
const rows = [];
for (const [file, what] of SUITES) {
  process.stdout.write('  ' + file.padEnd(20) + what.padEnd(16));
  const r = await run(file);
  r.ok = r.found && r.pass === r.total && r.code === 0;
  rows.push({ file, what, ...r });
  console.log(r.ok ? 'OK   ' + r.pass + '/' + r.total : 'BAD  ' + (r.found ? r.pass + '/' + r.total : '没有结论行'));
  for (const b of r.bad) console.log('        ' + b.trim());
}

const suites = rows.filter((r) => r.found);
const pass = suites.reduce((a, r) => a + r.pass, 0);
const total = suites.reduce((a, r) => a + r.total, 0);
const badRows = rows.filter((r) => !r.ok);

console.log('\n' + '-'.repeat(58));
console.log('  ' + suites.length + '/' + rows.length + ' 个套件有结论，断言 ' + pass + '/' + total +
  '，共 ' + (rows.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1) + 's');
for (const r of rows) console.log('    ' + (r.ok ? 'ok  ' : 'XX  ') + r.file.padEnd(20) + (r.ms / 1000).toFixed(1) + 's');
if (badRows.length) {
  console.log('\n  没过的：' + badRows.map((r) => r.file).join(', '));
  process.exitCode = 1;
} else {
  console.log('\n  全绿');
}
