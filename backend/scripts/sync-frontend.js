/**
 * Copies the built Angular app into backend/public, which is what the server serves.
 * Run it after every frontend build, otherwise the server keeps serving an older bundle
 * that may call endpoints this API no longer has.
 *
 *   npm run sync:frontend        (or: npm run build:web to build and copy in one step)
 */
const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser');
const target = path.join(__dirname, '..', 'public');

if (!fs.existsSync(path.join(source, 'index.html'))) {
  console.error(`No build found at ${source}. Run "npm run build" in ../frontend first.`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });

const files = fs.readdirSync(target).length;
const built = fs.statSync(path.join(target, 'index.html')).mtime.toISOString();
console.log(`Copied ${files} entries into backend/public (build from ${built}).`);
