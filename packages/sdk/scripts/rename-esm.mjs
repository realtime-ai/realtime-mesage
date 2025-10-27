import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');

function renameFiles(dir) {
  const files = fs.readdirSync(dir);

  files.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      renameFiles(fullPath);
    } else if (file.endsWith('.js') && !file.endsWith('.mjs')) {
      const newPath = fullPath.replace(/\.js$/, '.mjs');
      fs.renameSync(fullPath, newPath);
    }
  });
}

renameFiles(distDir);
console.log('✅ ESM files renamed to .mjs');
