import fs from 'node:fs';
for (const f of ['zombie.png', 'skeleton.png', 'creeper.png', 'pig.png', 'cow.png', 'sheep.png', 'chicken.png']) {
  const b = fs.readFileSync('../textures/entity/' + f);
  let off = 8, ihdr;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') {
      ihdr = { w: b.readUInt32BE(off + 8), h: b.readUInt32BE(off + 12), depth: b[off + 16], color: b[off + 17] };
      break;
    }
    off += 12 + len;
  }
  console.log(f.padEnd(12), ihdr);
}