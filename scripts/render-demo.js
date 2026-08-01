#!/usr/bin/env node
'use strict';

// Renders the CLI's REAL output to an SVG for the README.
//
// This is not a mock-up. It runs the actual binary, captures the actual
// bytes including ANSI colour, and draws them. That matters: a hand-drawn
// screenshot drifts from reality the first time output changes, and then
// the README is quietly lying. Re-run this after any change to the
// renderer and commit the result.
//
//   node scripts/render-demo.js

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'blastradius.js');
const OUT = path.join(__dirname, '..', 'assets');

// Terminal palette. Tuned to read well on GitHub in both themes, which is
// why the background is near-black rather than pure black.
const BG = '#0d1117';
const FG = '#c9d1d9';
const COLORS = { 31: '#ff7b72', 32: '#7ee787', 33: '#e3b341', 2: '#6e7681', 1: FG };

const CHAR_W = 8.4;
const LINE_H = 20;
const PAD = 18;

/** Split an ANSI-coloured string into {text, color, bold} runs. */
function parseAnsi(line) {
  const runs = [];
  let color = FG;
  let bold = false;
  let buf = '';

  const flush = () => { if (buf) { runs.push({ text: buf, color, bold }); buf = ''; } };

  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '' && line[i + 1] === '[') {
      const end = line.indexOf('m', i);
      if (end === -1) { buf += line[i]; continue; }
      flush();
      for (const code of line.slice(i + 2, end).split(';')) {
        const n = Number(code);
        if (n === 0) { color = FG; bold = false; }
        else if (n === 1) bold = true;
        else if (COLORS[n]) color = COLORS[n];
      }
      i = end;
      continue;
    }
    buf += line[i];
  }
  flush();
  return runs;
}

const escapeXml = (s) => s.replace(/[&<>"']/g, (ch) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]
));

/** Run one command and return its output lines, prefixed with the prompt. */
function capture(args) {
  let out;
  try {
    out = execFileSync('node', [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '1' },
    });
  } catch (err) {
    // check() exits 2 by design for anything needing confirmation.
    out = err.stdout || '';
  }
  const prompt = `[2m$[0m blastradius ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  return [prompt, ...out.replace(/\n+$/, '').split('\n')];
}

function render(blocks, file) {
  const lines = [];
  blocks.forEach((b, i) => {
    if (i) lines.push('');
    lines.push(...b);
  });

  const cols = Math.max(...lines.map((l) => l.replace(/\[[0-9;]*m/g, '').length));
  const width = Math.ceil(cols * CHAR_W + PAD * 2);
  const height = lines.length * LINE_H + PAD * 2;

  const body = lines.map((line, row) => {
    const y = PAD + (row + 1) * LINE_H - 6;
    let x = PAD;
    const spans = parseAnsi(line).map((run) => {
      const el = `<tspan x="${x.toFixed(1)}" y="${y}"${run.color !== FG ? ` fill="${run.color}"` : ''}`
        + `${run.bold ? ' font-weight="bold"' : ''}>${escapeXml(run.text)}</tspan>`;
      x += run.text.length * CHAR_W;
      return el;
    }).join('');
    return spans;
  }).join('\n    ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="blastradius terminal output">
  <rect width="${width}" height="${height}" rx="8" fill="${BG}"/>
  <text font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="14" fill="${FG}" xml:space="preserve">
    ${body}
  </text>
</svg>
`;

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), svg);
  console.log(`  ${file}  (${lines.length} lines, ${width}x${height})`);
}

console.log('rendering from live CLI output:');

render([
  capture(['check', 'kubectl get pods']),
  capture(['check', 'rm -rf ./build']),
  capture(['check', 'git push --force origin main']),
  capture(['check', 'terraform destroy -auto-approve']),
], 'demo.svg');

render([
  capture(['check', "ssh deploy@web01 'rm -rf /var/www'"]),
], 'demo-ssh.svg');
