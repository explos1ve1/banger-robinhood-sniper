import fs from 'node:fs';
import path from 'node:path';
process.env.FORCE_COLOR = '1';
const { terminal } = await import('../src/terminal.js');
const { demoState } = await import('../src/demo.js');
const { loadConfig } = await import('../src/config.js');
const root = path.resolve('docs/assets');
fs.mkdirSync(root, { recursive: true });
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const lines = terminal(demoState(15), loadConfig({ MODE: 'paper' }), 124, true, 116).split('\n');
const cell = 8.65,
  lineHeight = 22,
  width = 1100,
  height = lines.length * lineHeight + 94;
let spans = '';
for (let row = 0; row < lines.length; row++) {
  let col = 0,
    color = '#eff3e9',
    bold = false;
  for (const piece of lines[row]!.split(/(\u001b\[[0-9;]*m)/)) {
    if (piece.startsWith('\u001b[')) {
      const codes = piece.slice(2, -1).split(';').map(Number);
      for (let j = 0; j < codes.length; j++) {
        const n = codes[j];
        if (n === 0) {
          color = '#eff3e9';
          bold = false;
        } else if (n === 1) bold = true;
        else if (n === 22) bold = false;
        else if (n === 39) color = '#eff3e9';
        else if (n === 38 && codes[j + 1] === 2) {
          color = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`;
          j += 4;
        }
      }
    } else if (piece) {
      const count = Array.from(piece).length;
      const positions = Array.from(piece, (_, index) =>
        (48 + (col + index) * cell).toFixed(2),
      ).join(' ');
      spans += `<text x="${positions}" y="${79 + row * lineHeight}" fill="${color}" font-weight="${bold ? 700 : 400}">${esc(piece)}</text>\n`;
      col += count;
    }
  }
}
fs.writeFileSync(
  path.join(root, 'terminal.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Actual BANGER offline terminal renderer; all displayed trades are simulated">
<rect width="${width}" height="${height}" rx="18" fill="#030706"/><rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="18" fill="none" stroke="#2b4335"/>
<rect width="${width}" height="42" rx="18" fill="#111c17"/><circle cx="23" cy="21" r="5" fill="#ff7865"/><circle cx="42" cy="21" r="5" fill="#ffc676"/><circle cx="61" cy="21" r="5" fill="#4cffa8"/>
<text x="${width / 2}" y="26" text-anchor="middle" font-family="monospace" font-size="12" fill="#90a49a">banger · offline demo · no wallet connected</text>
<g font-family="DejaVu Sans Mono,Consolas,monospace" font-size="14.25" xml:space="preserve">${spans}</g></svg>`,
);
fs.writeFileSync(
  path.join(root, 'banner.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="440" viewBox="0 0 1600 440" role="img" aria-label="BANGER — open-source sniper terminal for Robinhood Chain">
<defs><radialGradient id="a"><stop stop-color="#365818" stop-opacity=".6"/><stop offset="1" stop-color="#040807" stop-opacity="0"/></radialGradient><pattern id="g" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" fill="none" stroke="#244032" stroke-width=".6"/></pattern></defs>
<rect width="1600" height="440" rx="22" fill="#040807"/><rect x="1" y="1" width="1598" height="438" rx="22" fill="none" stroke="#2b4030"/><rect x="870" y="16" width="710" height="408" fill="url(#g)" opacity=".65"/><ellipse cx="1290" cy="232" rx="400" ry="220" fill="url(#a)"/>
<path d="M38 44V395" stroke="#c7ff42" stroke-width="5"/>
<text x="75" y="74" fill="#a2b6a7" font-family="monospace" font-size="19" letter-spacing="3">OPEN SOURCE / SNIPER TERMINAL</text>
<text x="68" y="201" fill="#eff3e9" font-family="Arial,sans-serif" font-size="112" font-style="italic" font-weight="900" letter-spacing="2">BANGER</text>
<text x="76" y="251" fill="#c7ff42" font-family="Arial,sans-serif" font-size="27" font-weight="700">FIND IT. LOCK IT. BANG.</text>
<text x="76" y="293" fill="#99ada0" font-family="Arial,sans-serif" font-size="22">Robinhood Chain · ETH-native entries · Your machine, your keys.</text>
<g font-family="monospace" font-size="17" font-weight="700"><rect x="76" y="339" width="162" height="36" rx="5" fill="#c7ff42"/><text x="94" y="363" fill="#040807">V3 SCANNER</text><rect x="250" y="339" width="176" height="36" rx="5" fill="#16281b"/><text x="269" y="363" fill="#4cffa8">PAPER / LIVE</text><rect x="438" y="339" width="220" height="36" rx="5" fill="#16281b"/><text x="457" y="363" fill="#4cffa8">BOUNDED EXECUTION</text></g>
<g fill="none" stroke="#86c44a"><ellipse cx="1245" cy="235" rx="273" ry="142" opacity=".22"/><ellipse cx="1245" cy="235" rx="204" ry="101" opacity=".3"/><ellipse cx="1245" cy="235" rx="128" ry="63" opacity=".24"/></g>
<path d="M1064 274 Q1160 70 1419 183 M1064 274 Q1270 383 1370 302 M1064 274 Q1120 112 1253 111" fill="none" stroke="#7fea68" stroke-width="2" opacity=".7"/>
<circle cx="1064" cy="274" r="52" fill="#0b1b10" stroke="#c7ff42" stroke-width="2"/><path d="M1053 242H1080L1067 267H1082L1048 308L1059 279H1045Z" fill="#c7ff42"/>
<g fill="#0a1811" stroke="#4cffa8" stroke-width="2"><circle cx="1419" cy="183" r="36"/><circle cx="1370" cy="302" r="24"/><circle cx="1253" cy="111" r="24"/></g>
<g fill="#c7ff42" font-family="monospace" font-size="18" text-anchor="middle"><text x="1419" y="189">ETH</text><text x="1370" y="308">V3</text><text x="1253" y="117">LP</text></g>
<path d="M1365 157V131H1391M1447 131H1473V157M1473 208V235H1447M1391 235H1365V208" fill="none" stroke="#c7ff42" stroke-width="3"/>
<text x="1286" y="397" fill="#a0b39c" font-family="monospace" font-size="16" text-anchor="middle">SCAN → CHECK → ENTER → MANAGE</text></svg>`,
);
console.log('Rendered docs/assets/banner.svg and terminal.svg from the actual terminal renderer.');
