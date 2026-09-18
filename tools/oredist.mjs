// 纯 Node 统计矿物与基岩的 Y 分布，不启浏览器。用法：node tools/oredist.mjs [区块边长]
import { generateChunk, biomeAt, terrainHeight, ORE_TABLE } from '../js/worldgen.js';
import { BLOCKS } from '../js/blocks.js';
import { CHUNK, HEIGHT, SEA } from '../js/worlddef.js';

const N = Math.max(4, parseInt(process.argv[2] || '24', 10));

const ORES = ['coal_ore', 'copper_ore', 'iron_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore', 'diamond_ore'];
const oreId = {};
for (const k of ORES) oreId[BLOCKS.findIndex((b) => b.key === k)] = k;
const BEDROCK = BLOCKS.findIndex((b) => b.key === 'bedrock');
const STONE = BLOCKS.findIndex((b) => b.key === 'stone');
const AIR = 0;

const perOre = {};
for (const k of ORES) perOre[k] = { byY: new Array(HEIGHT).fill(0), total: 0 };
const bedrockByY = new Array(HEIGHT).fill(0);
const stoneByY = new Array(HEIGHT).fill(0);
const solidByY = new Array(HEIGHT).fill(0);
const surfaceHist = new Array(HEIGHT).fill(0);

// 矿脉尺寸分布：对每块矿石做连通分量统计（只用 6 邻接、只在区块内）
const veinSizes = {};
for (const k of ORES) veinSizes[k] = [];
const seen = new Uint8Array(CHUNK * CHUNK * HEIGHT);

const t0 = Date.now();
let chunks = 0;
for (let cz = 0; cz < N; cz++) {
  for (let cx = 0; cx < N; cx++) {
    const ch = {
      cx, cz,
      data: new Uint8Array(CHUNK * CHUNK * HEIGHT),
      surface: new Uint8Array(CHUNK * CHUNK)
    };
    generateChunk(ch);
    chunks++;

    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) surfaceHist[ch.surface[lx + CHUNK * lz]]++;
    }

    for (let y = 0; y < HEIGHT; y++) {
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = lx + CHUNK * (lz + CHUNK * y);
          const id = ch.data[i];
          if (id !== AIR) solidByY[y]++;
          if (id === BEDROCK) bedrockByY[y]++;
          if (id === STONE) stoneByY[y]++;
          const name = oreId[id];
          if (name) { perOre[name].byY[y]++; perOre[name].total++; }
        }
      }
    }

    // 连通分量（仅区块内，用于看矿脉大小）
    seen.fill(0);
    const idxAt = (lx, y, lz) => lx + CHUNK * (lz + CHUNK * y);
    const stack = [];
    for (let y = 1; y < HEIGHT; y++) {
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = idxAt(lx, y, lz);
          const name = oreId[ch.data[i]];
          if (!name || seen[i]) continue;
          let size = 0;
          stack.length = 0;
          stack.push(i);
          seen[i] = 1;
          while (stack.length) {
            const cur = stack.pop();
            size++;
            const cy = (cur / (CHUNK * CHUNK)) | 0;
            const rest = cur - cy * CHUNK * CHUNK;
            const czz = (rest / CHUNK) | 0;
            const cxx = rest - czz * CHUNK;
            const nbrs = [
              cxx > 0 ? idxAt(cxx - 1, cy, czz) : -1,
              cxx < CHUNK - 1 ? idxAt(cxx + 1, cy, czz) : -1,
              czz > 0 ? idxAt(cxx, cy, czz - 1) : -1,
              czz < CHUNK - 1 ? idxAt(cxx, cy, czz + 1) : -1,
              cy > 1 ? idxAt(cxx, cy - 1, czz) : -1,
              cy < HEIGHT - 1 ? idxAt(cxx, cy + 1, czz) : -1
            ];
            for (const n of nbrs) {
              if (n < 0 || seen[n]) continue;
              if (oreId[ch.data[n]] !== name) continue;
              seen[n] = 1;
              stack.push(n);
            }
          }
          veinSizes[name].push(size);
        }
      }
    }
  }
}

const totalCells = chunks * CHUNK * CHUNK;
console.log('统计 ' + N + '×' + N + ' = ' + chunks + ' 个区块，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('世界：HEIGHT=' + HEIGHT + '  SEA=' + SEA);

const bar = (v, max, w) => {
  const n = max === 0 ? 0 : Math.round((v / max) * w);
  return '█'.repeat(n) + '·'.repeat(Math.max(0, w - n));
};
const pad = (s, w) => String(s).padStart(w);

console.log('\n========== 一、地表高度分布（每格 = 一列地形的顶） ==========');
const shMax = Math.max(...surfaceHist);
for (let y = HEIGHT - 1; y >= 0; y--) {
  if (surfaceHist[y] === 0) continue;
  console.log('  y=' + pad(y, 2) + ' ' + pad(surfaceHist[y], 6) + ' ' + bar(surfaceHist[y], shMax, 40));
}

console.log('\n========== 二、各矿石的 Y 分布 ==========');
console.log('  （行 = y 层，数字 = 该层矿石格数；矿只在石头里生成，所以地表以上必然为 0）');
const oreHeader = ORES.map((k) => pad(BLOCKS.find((b) => b.key === k).label.replace('矿石', ''), 6)).join('');
console.log('   y   ' + oreHeader + '  该层石头数');

for (let y = HEIGHT - 1; y >= 0; y--) {
  let any = false;
  for (const k of ORES) if (perOre[k].byY[y] > 0) any = true;
  if (!any) continue;
  const row = ORES.map((k) => pad(perOre[k].byY[y] || '', 6)).join('');
  console.log('  ' + pad(y, 3) + '  ' + row + '  ' + pad(stoneByY[y], 8));
}

console.log('\n========== 三、每种矿石的汇总 ==========');
console.log('  矿石      总量      占石头比   实际y范围   峰值y   峰层占比');
for (const k of ORES) {
  const o = perOre[k];
  let lo = -1, hi = -1, peak = 0, peakV = 0;
  let stoneInRange = 0;
  for (let y = 0; y < HEIGHT; y++) {
    if (o.byY[y] > 0) { if (lo < 0) lo = y; hi = y; }
    if (o.byY[y] > peakV) { peakV = o.byY[y]; peak = y; }
  }
  for (let y = 0; y < HEIGHT; y++) stoneInRange += stoneByY[y];
  const pct = stoneInRange ? (o.total / stoneInRange * 100) : 0;
  console.log('  ' + pad(BLOCKS.find((b) => b.key === k).label, 10) + pad(o.total, 8) + '   ' +
    pad(pct.toFixed(4) + '%', 9) + '   ' + pad(lo < 0 ? '-' : (lo + '..' + hi), 10) + '  ' +
    pad(peak, 5) + '   ' + pad((peakV / (stoneInRange || 1) * 100).toFixed(4) + '%', 9));
}

console.log('\n========== 四、矿脉尺寸分布（区块内 6 邻接连通分量） ==========');
console.log('  矿石      脉数    p50   p90   p99   最大   平均   单格脉占比');
for (const k of ORES) {
  const v = veinSizes[k];
  if (!v.length) { console.log('  ' + pad(BLOCKS.find((b) => b.key === k).label, 10) + pad(0, 8)); continue; }
  const sorted = [...v].sort((a, b) => a - b);
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const solo = v.filter((s) => s === 1).length / v.length * 100;
  console.log('  ' + pad(BLOCKS.find((b) => b.key === k).label, 10) + pad(v.length, 8) + '   ' +
    pad(q(0.5), 4) + '  ' + pad(q(0.9), 4) + '  ' + pad(q(0.99), 4) + '  ' + pad(sorted[sorted.length - 1], 5) + '  ' +
    pad(avg.toFixed(2), 6) + '   ' + pad(solo.toFixed(1) + '%', 8));
}

console.log('\n========== 五、基岩层 ==========');
for (let y = 0; y < 8; y++) {
  const cols = chunks * CHUNK * CHUNK;
  if (bedrockByY[y] === 0) continue;
  console.log('  y=' + pad(y, 2) + ' ' + pad(bedrockByY[y], 8) + ' 格  占该层 ' + pad((bedrockByY[y] / cols * 100).toFixed(2) + '%', 7) + ' ' + bar(bedrockByY[y], cols, 40));
}
const bedrockCols = bedrockByY.reduce((a, b) => a + b, 0);
console.log('  基岩总格数 ' + bedrockCols + '（若为单一平面则为 ' + chunks * CHUNK * CHUNK + '）');

console.log('\n========== 六、层次体检 ==========');
// 找「有大量石头但一个矿都没有」的 y 层
const emptyBands = [];
let runStart = -1;
for (let y = 1; y < HEIGHT; y++) {
  let ores = 0;
  for (const k of ORES) ores += perOre[k].byY[y];
  const hasStone = stoneByY[y] > chunks * CHUNK * CHUNK * 0.02;
  if (hasStone && ores === 0) { if (runStart < 0) runStart = y; }
  else if (runStart >= 0) { emptyBands.push(runStart + '..' + (y - 1)); runStart = -1; }
}
if (runStart >= 0) emptyBands.push(runStart + '..' + (HEIGHT - 1));
console.log('  有石头但完全没有矿石的 y 区间: ' + (emptyBands.length ? emptyBands.join(', ') : '无'));
let maxStoneY = 0, minOreY = HEIGHT, maxOreY = 0;
for (let y = 0; y < HEIGHT; y++) if (stoneByY[y] > 0) maxStoneY = y;
for (const k of ORES) for (let y = 0; y < HEIGHT; y++) {
  if (perOre[k].byY[y] > 0) { if (y < minOreY) minOreY = y; if (y > maxOreY) maxOreY = y; }
}
console.log('  石头最高出现在 y=' + maxStoneY + '（该层只有 ' + stoneByY[maxStoneY] + ' 格，是零星的高地）');
console.log('  矿石最高到 y=' + maxOreY + '（差 ' + (maxStoneY - maxOreY) + ' 层，矿只在石头里，所以这个差必然 ≥ 0）');
console.log('  矿石最低 y=' + minOreY + '（基岩在 y=0）');

console.log('\n========== 七、山地采样（绿宝石是山地专属矿，主采样区里可能一株都没有） ==========');
const mtn = [];
for (let cz = -260; cz <= 260 && mtn.length < 60; cz++) {
  for (let cx = -260; cx <= 260; cx++) {
    if (biomeAt(cx * CHUNK + 8, cz * CHUNK + 8) !== 'mountains') continue;
    mtn.push([cx, cz]);
    if (mtn.length >= 60) break;
  }
}
if (!mtn.length) {
  console.log('  在 ±260 区块范围内没有找到山地群系 —— 绿宝石将无法获取，需要检查山地生成条件');
} else {
  const emerald = BLOCKS.findIndex((b) => b.key === 'emerald_ore');
  let mStone = 0, mEmerald = 0, mAllOre = 0;
  const mEmeraldByY = new Array(HEIGHT).fill(0);
  const mHeights = [];
  for (const [cx, cz] of mtn) {
    const ch = { cx, cz, data: new Uint8Array(CHUNK * CHUNK * HEIGHT), surface: new Uint8Array(CHUNK * CHUNK) };
    generateChunk(ch);
    for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) mHeights.push(ch.surface[lx + CHUNK * lz]);
    for (let y = 1; y < HEIGHT; y++) {
      for (let lz = 0; lz < CHUNK; lz++) for (let lx = 0; lx < CHUNK; lx++) {
        const id = ch.data[lx + CHUNK * (lz + CHUNK * y)];
        if (id === STONE) mStone++;
        const nm = oreId[id];
        if (!nm) continue;
        mAllOre++;
        if (nm === 'emerald_ore') { mEmerald++; mEmeraldByY[y]++; }
      }
    }
  }
  mHeights.sort((a, b) => a - b);
  console.log('  取前 ' + mtn.length + ' 个山地区块（首个 ' + mtn[0].join(',') + '）——是采样上限，不是全部山地');
  console.log('  山地地表高度：min=' + mHeights[0] + '  p50=' + mHeights[(mHeights.length / 2) | 0] + '  max=' + mHeights[mHeights.length - 1]);
  console.log('  山地石头总量 ' + mStone + '，其中绿宝石 ' + mEmerald + ' 格 = ' + (mStone ? (mEmerald / mStone * 100).toFixed(3) + '%' : '-'));
  console.log('  山地整体矿化率 ' + (mStone ? (mAllOre / mStone * 100).toFixed(2) + '%' : '-') + '（对比全图 ' + (stoneByY.reduce((a, b) => a + b, 0) ? (ORES.reduce((a, k) => a + perOre[k].total, 0) / stoneByY.reduce((a, b) => a + b, 0) * 100).toFixed(2) + '%' : '-') + '）');
  let lo = -1, hi = -1;
  for (let y = 0; y < HEIGHT; y++) if (mEmeraldByY[y] > 0) { if (lo < 0) lo = y; hi = y; }
  console.log('  绿宝石实际出现 y 范围：' + (lo < 0 ? '一株都没有！' : lo + '..' + hi));
  console.log('\n  绿宝石在 y=35..75 的分布：');
  for (let y = 75; y >= 35; y--) {
    if (mEmeraldByY[y] === 0) continue;
    console.log('    y=' + pad(y, 2) + ' ' + pad(mEmeraldByY[y], 5) + ' ' + bar(mEmeraldByY[y], Math.max(...mEmeraldByY), 40));
  }
}

// 断言：前七节是「看」，这一节是「卡」。矿层、矿脉尺寸、基岩只要被改坏，这里必须红。
console.log('\n========== 八、断言 ==========');
let pass = 0, fail = 0;
const check = (ok, label, detail) => {
  if (ok) pass++; else fail++;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  [' + detail + ']' : ''));
};

const stoneTotal = stoneByY.reduce((a, b) => a + b, 0);
const oreTotal = ORES.reduce((a, k) => a + perOre[k].total, 0);
const rate = oreTotal / stoneTotal * 100;
check(rate > 9 && rate < 15, '总矿化率落在 9%~15%', rate.toFixed(2) + '%');
check(bedrockByY[0] === chunks * CHUNK * CHUNK, 'y=0 基岩铺满（挖不穿世界底）', bedrockByY[0] + '/' + chunks * CHUNK * CHUNK);

for (const o of ORE_TABLE) {
  const k = BLOCKS[o.block].key;
  const label = BLOCKS[o.block].label;
  const sizes = veinSizes[k];
  const maxVein = sizes.length ? Math.max(...sizes) : 0;
  check(maxVein <= o.size, label + ' 区块内最大矿脉不超过 size', '实测 ' + maxVein + ' ≤ 声明 ' + o.size + '（跨区块边界两条脉可能贴在一起，连锁时算一条，最多翻倍）');
  const v = perOre[k];
  if (v.total === 0) {
    console.log('  SKIP  ' + label + ' 主采样区没有（山地专属，见第七节）');
    continue;
  }
  const peak = v.byY.indexOf(Math.max(...v.byY));
  const lo = v.byY.findIndex((n) => n > 0);
  check(peak >= o.minY && peak <= o.maxY, label + ' 峰值层落在层带内', '峰值 y=' + peak + ' ∈ [' + o.minY + ',' + o.maxY + ']');
  check(lo >= 1, label + ' 没渗进 y=0 基岩层', '最低 y=' + lo);
}
check(maxOreY <= maxStoneY, '没有矿石浮在石头之上', '矿石 ' + maxOreY + ' ≤ 石头 ' + maxStoneY);
check(emptyBands.length === 0, '没有「有石头却完全没矿」的层', emptyBands.length ? emptyBands.join(', ') : '无');

const coalPeak = perOre.coal_ore.byY.indexOf(Math.max(...perOre.coal_ore.byY));
const ironPeak = perOre.iron_ore.byY.indexOf(Math.max(...perOre.iron_ore.byY));
check(coalPeak > ironPeak, '煤比铁浅（浅矿真的浅）', '煤 y=' + coalPeak + ' > 铁 y=' + ironPeak);

console.log('  ------------------------------------------');
console.log('  通过 ' + pass + '/' + (pass + fail) + (fail ? '  ← 有失败' : ''));
if (fail) process.exitCode = 1;
