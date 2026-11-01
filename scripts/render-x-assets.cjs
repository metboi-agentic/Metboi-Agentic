// Renders the X profile logo and banner to marketing/x. Usage: node scripts/render-x-assets.cjs <font file> [resvg module path]
const fs = require('fs');
const path = require('path');
const fontFile = process.argv[2];
const { Resvg } = require(process.argv[3] ?? '@resvg/resvg-js');
const root = path.join(__dirname, '..');
const out = path.join(root, 'marketing/x');
const logo = `data:image/png;base64,${fs.readFileSync(path.join(root, 'assets-source/metboi-logo.png')).toString('base64')}`;
const BG = '#0d0d13', INK = '#f4f4f8', MUTED = '#b4b4c6', ACCENT = '#f55800', FONT = 'Geist Mono';
const LOGO_RATIO = 882 / 986;

function render(name, width, svg) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { fontFiles: [fontFile], loadSystemFonts: false, defaultFontFamily: FONT } }).render().asPng();
  fs.writeFileSync(path.join(out, name), png);
  console.log(name, png.length);
}

const LOGO_SIZE = 300;
render('metboi-x-logo.png', 400, `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
  <rect width="400" height="400" fill="${BG}"/>
  <image href="${logo}" x="${(400 - LOGO_SIZE) / 2}" y="${(400 - LOGO_SIZE * LOGO_RATIO) / 2}" width="${LOGO_SIZE}" height="${LOGO_SIZE * LOGO_RATIO}"/>
</svg>`);

// Banner: an abstract gradient with one soft liquidity curve drawn as thin bars, and two lines of text.
const W = 1500, H = 500, BAR_STEP = 9, BAR_WIDTH = 2.5, CREST_X = 1090, CREST_WIDTH = 330, CREST_HEIGHT = 330, FLOOR = 36;
let bars = '';
for (let x = 740; x < W + BAR_STEP; x += BAR_STEP) {
  const crest = CREST_HEIGHT * Math.exp(-(((x - CREST_X) / CREST_WIDTH) ** 2));
  const ripple = 26 * Math.sin(x / 74) + 12 * Math.sin(x / 23);
  const h = Math.max(FLOOR, crest + ripple + FLOOR);
  const y = (H - h) / 2 + 30;
  bars += `<rect x="${x}" y="${y.toFixed(1)}" width="${BAR_WIDTH}" height="${h.toFixed(1)}" fill="url(#barFill)"/>`;
}

render('metboi-x-banner.png', W, `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="${FONT}" font-weight="500">
  <defs>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="72"/></filter>
    <linearGradient id="barFill" gradientUnits="userSpaceOnUse" x1="740" y1="0" x2="${W}" y2="0">
      <stop offset="0" stop-color="#6e45ff" stop-opacity="0"/>
      <stop offset=".3" stop-color="#9e83ff" stop-opacity=".75"/>
      <stop offset=".68" stop-color="#ff8a4c" stop-opacity=".95"/>
      <stop offset="1" stop-color="#f55800" stop-opacity=".55"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${BG}"/><stop offset=".3" stop-color="${BG}" stop-opacity=".88"/><stop offset=".62" stop-color="${BG}" stop-opacity="0"/>
    </linearGradient>
    <filter id="grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7"/>
      <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .055 0"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <g filter="url(#soft)">
    <ellipse cx="830" cy="120" rx="340" ry="190" fill="#6e45ff" fill-opacity=".85"/>
    <ellipse cx="1180" cy="340" rx="380" ry="210" fill="${ACCENT}" fill-opacity=".95"/>
    <ellipse cx="1420" cy="90" rx="220" ry="150" fill="#ff2f6d" fill-opacity=".55"/>
    <ellipse cx="1040" cy="250" rx="150" ry="110" fill="#ffb27a" fill-opacity=".45"/>
  </g>
  <rect width="${W}" height="${H}" fill="url(#fade)"/>
  ${bars}
  <rect width="${W}" height="${H}" filter="url(#grain)"/>
  <text x="84" y="226" font-size="82" letter-spacing="-4.6" fill="${INK}">Metboi Agentic</text>
  <text x="88" y="280" font-size="23" letter-spacing="-.6" fill="#c6c6d6">AI agents on Meteora, inside limits you set.</text>
</svg>`);
