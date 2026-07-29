// Generates PWA icons into packages/client/public/ from an inline SVG badger.
// Run: node scripts/gen-icons.mjs   (requires devDep: sharp)
import { mkdirSync } from 'node:fs'
import sharp from 'sharp'

const OUT = new URL('../packages/client/public/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

// Minimalist badger head: dark rounded tile, white head wedge with two black
// stripes, orange nose. Pure shapes — no fonts.
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#151a22"/>
  <g transform="translate(256 ${266 + pad * 0.0}) scale(${1 - pad / 256})">
    <!-- head wedge -->
    <path d="M0 -170 C 95 -170 160 -95 160 20 C 160 120 90 175 0 175 C -90 175 -160 120 -160 20 C -160 -95 -95 -170 0 -170 Z" fill="#e8edf4"/>
    <!-- eye stripes -->
    <path d="M-58 -166 C -30 -172 -16 -168 -12 -140 L -34 60 C -40 96 -78 96 -86 60 L -104 -120 C -100 -148 -84 -160 -58 -166 Z" fill="#10141a"/>
    <path d="M58 -166 C 30 -172 16 -168 12 -140 L 34 60 C 40 96 78 96 86 60 L 104 -120 C 100 -148 84 -160 58 -166 Z" fill="#10141a"/>
    <!-- ears -->
    <circle cx="-140" cy="-118" r="38" fill="#10141a"/>
    <circle cx="140" cy="-118" r="38" fill="#10141a"/>
    <!-- nose -->
    <path d="M0 100 C 26 100 40 116 40 132 C 40 156 18 170 0 170 C -18 170 -40 156 -40 132 C -40 116 -26 100 0 100 Z" fill="#ffb454"/>
  </g>
</svg>`

const renders = [
  ['icon-192.png', 192, 0],
  ['icon-512.png', 512, 0],
  ['icon-512-maskable.png', 512, 60],
  ['apple-touch-icon.png', 180, 0],
]
for (const [name, size, pad] of renders) {
  await sharp(Buffer.from(svg(pad))).resize(size, size).png().toFile(OUT + name)
  console.log('wrote', name)
}
