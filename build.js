/*
 * build.js — inlines game.js into index.html.
 *
 * Why: browsers block *local* ES modules over file:// (CORS). An inline
 * <script type="module"> is not fetched, so the game runs by just
 * double-clicking index.html. Three.js still comes from the CDN.
 *
 * Usage:  node build.js
 */
const fs = require('fs');
const path = require('path');

const root = __dirname;
const htmlPath = path.join(root, 'index.html');
const jsPath = path.join(root, 'game.js');

const html = fs.readFileSync(htmlPath, 'utf8');
const js = fs.readFileSync(jsPath, 'utf8');

if (js.includes('</script')) {
  console.error('ERROR: game.js contains a "</script" sequence and cannot be inlined.');
  process.exit(1);
}

const open = '<script type="module">';
const start = html.indexOf(open);
if (start === -1) {
  console.error('ERROR: could not find <script type="module"> in index.html');
  process.exit(1);
}
const end = html.lastIndexOf('</script>');
if (end === -1 || end < start) {
  console.error('ERROR: could not find the closing </script> in index.html');
  process.exit(1);
}

const banner = open + '\n/* ==== INLINED FROM game.js — edit game.js then run `node build.js` ==== */\n';
const out = html.slice(0, start) + banner + js + '\n' + html.slice(end);

fs.writeFileSync(htmlPath, out);
console.log('built index.html -> ' + out.length + ' bytes (from game.js ' + js.length + ' bytes)');
