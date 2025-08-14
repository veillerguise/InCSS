#!/usr/bin/env node
/**
 * All-in-one HTML+CSS compressor
 * - Extracts and deduplicates inline styles into short class names (a, b, c, ...)
 * - Extracts very-common declarations into a single "common" class
 * - Minifies the generated CSS (postcss + cssnano)
 * - Minifies the HTML output (html-minifier-terser)
 *
 * Usage:
 *   node compress.js input.html
 *   Writes compressed output to output.html (same folder as input)
 *
 * Requires: jsdom, postcss, cssnano, html-minifier-terser
 *   npm install jsdom postcss cssnano html-minifier-terser
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const postcss = require('postcss');
const cssnano = require('cssnano');
const { minify: minifyHtml } = require('html-minifier-terser');
const puppeteer = require('puppeteer');

// Generate short class names: a, b, ..., z, aa, ab, ...
function* classNameGen() {
  let i = 0;
  while (true) {
    let s = '';
    let n = i;
    do {
      s = String.fromCharCode(97 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    yield s;
    i++;
  }
}

function parseStyle(style) {
  return style
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const idx = s.indexOf(':');
      if (idx === -1) return null;
      const prop = s.slice(0, idx).trim().toLowerCase();
      const val = s.slice(idx + 1).trim();
      if (!val) return null; // drop empty values (common in some toolchains)
      return `${prop}:${val}`;
    })
    .filter(Boolean);
}


async function htmlToPdf(htmlPath, pdfPath) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('file://' + htmlPath, { waitUntil: 'networkidle0' });
  // Remove sticky/fixed elements (e.g., floating windows/toolbars)
  await page.evaluate(() => {
    // Remove all elements with position:fixed or position:sticky
    const all = Array.from(document.querySelectorAll('*'));
    for (const el of all) {
      const style = window.getComputedStyle(el);
      if (style.position === 'fixed' || style.position === 'sticky') {
        el.parentNode && el.parentNode.removeChild(el);
      }
    }
  });
  // Get the full height of the rendered page content
  const bodyHandle = await page.$('body');
  const boundingBox = await bodyHandle.boundingBox();
  const contentHeight = Math.ceil(boundingBox ? boundingBox.height : 0);
  await bodyHandle.dispose();
  // Set a large enough height to fit all content on one page
  await page.pdf({
    path: pdfPath,
    printBackground: true,
    width: '210mm',
    height: contentHeight ? `${contentHeight}px` : '297mm',
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    pageRanges: '1',
    preferCSSPageSize: false
  });
  await browser.close();
}

async function main() {
  if (process.argv.length < 3) {
    console.error('Usage: node compress.js <input.html> [--pdf]');
    process.exit(1);
  }

  const inputPath = path.resolve(process.argv[2]);
  const gen = classNameGen();
  const outputPath = path.join(path.dirname(inputPath), 'output.html');
  const toPdf = process.argv.includes('--pdf');

  const html = fs.readFileSync(inputPath, 'utf8');
  const dom = new JSDOM(html);
  const { document } = dom.window;

  const styledEls = Array.from(document.querySelectorAll('[style]'));

  // First pass: parse each element's inline style into canonical prop->val maps
  const elements = []; // { el, propMap }
  const declCount = new Map(); // counts for single declarations like 'prop:val'
  for (const el of styledEls) {
    const raw = (el.getAttribute('style') || '').trim();
    if (!raw) continue;
    const parsed = parseStyle(raw);
    if (parsed.length === 0) {
      el.removeAttribute('style');
      continue;
    }
    const propMap = new Map();
    for (const pv of parsed) {
      const idx = pv.indexOf(':');
      const prop = pv.slice(0, idx);
      const val = pv.slice(idx + 1);
      propMap.set(prop, val);
    }
    for (const [p, v] of propMap.entries()) {
      const key = `${p}:${v}`;
      declCount.set(key, (declCount.get(key) || 0) + 1);
    }
    elements.push({ el, propMap });
  }

  // Greedy shared-declaration extraction: pick single declarations that appear frequently
  const SHARED_THRESHOLD = 2; // more aggressive
  const sharedDecls = Array.from(declCount.entries()).filter(([,c]) => c >= SHARED_THRESHOLD).sort((a,b) => b[1]-a[1]).map(([d]) => d);
  const sharedClassForDecl = new Map();
  for (const decl of sharedDecls) {
    sharedClassForDecl.set(decl, gen.next().value);
  }

  // For each element, remove shared declarations from its propMap and record shared classes
  for (const item of elements) {
    item.shared = [];
    for (const decl of sharedDecls) {
      const idx = decl.indexOf(':');
      const prop = decl.slice(0, idx);
      const val = decl.slice(idx + 1);
      if (item.propMap.get(prop) === val) {
        item.propMap.delete(prop);
        item.shared.push(sharedClassForDecl.get(decl));
      }
    }
  }

  // Map remaining declaration-set -> class
  const declsetToClass = new Map();
  const bodyToSelectors = new Map();
  for (const item of elements) {
    const props = Array.from(item.propMap.entries()).sort((a,b) => a[0].localeCompare(b[0]));
    const body = props.map(([p,v]) => `${p}:${v}`).join(';');
    let perClass = null;
    if (body) {
      perClass = declsetToClass.get(body);
      if (!perClass) {
        perClass = gen.next().value;
        declsetToClass.set(body, perClass);
      }
    }
    const clsList = [];
    if (item.shared.length) clsList.push(...item.shared);
    if (perClass) clsList.push(perClass);
    if (clsList.length === 0) {
      item.el.removeAttribute('style');
    } else {
      item.el.setAttribute('class', clsList.join(' '));
      item.el.removeAttribute('style');
      if (perClass) {
        const arr = bodyToSelectors.get(body) || [];
        arr.push(`.${perClass}`);
        bodyToSelectors.set(body, arr);
      }
    }
  }

  // register shared single-declaration rules
  for (const [decl, cls] of sharedClassForDecl.entries()) {
    const arr = bodyToSelectors.get(decl) || [];
    arr.push(`.${cls}`);
    bodyToSelectors.set(decl, arr);
  }

  const rules = [];
  for (const [body, selectors] of bodyToSelectors.entries()) {
    rules.push(`${selectors.join(',')}{${body}}`);
  }
  let css = rules.join('');
  if (css) {
    const min = await postcss([cssnano({ preset: 'default' })]).process(css, { from: undefined });
    css = min.css;

    let head = document.querySelector('head');
    if (!head) {
      head = document.createElement('head');
      document.documentElement.insertBefore(head, document.body);
    }
    // remove existing style blocks
    Array.from(head.querySelectorAll('style')).forEach(s => s.remove());
    const styleBlock = document.createElement('style');
    styleBlock.type = 'text/css';
    styleBlock.textContent = css;
    head.insertBefore(styleBlock, head.firstChild);
  }

  const minifiedHtml = await minifyHtml(dom.serialize(), {
    collapseWhitespace: true,
    removeComments: true,
    minifyCSS: false,
    minifyJS: true,
    removeRedundantAttributes: true,
    removeEmptyAttributes: true,
    removeOptionalTags: true,
    sortAttributes: true,
    sortClassName: true
  });

  fs.writeFileSync(outputPath, minifiedHtml, 'utf8');
  const generated = declsetToClass.size;
  console.log(`Done. Wrote: ${outputPath}\nGenerated ${generated} classes.`);
  if (toPdf) {
    const pdfPath = path.join(path.dirname(outputPath), 'output.pdf');
    await htmlToPdf(outputPath, pdfPath);
    console.log(`PDF generated: ${pdfPath}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
        // remove existing style blocks
