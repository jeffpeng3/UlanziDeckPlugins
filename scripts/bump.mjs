#!/usr/bin/env node
// 版本號 bump：改 <plugin-dir>/manifest.json 的 Version，同步根 README.md 版本表
// 只動檔不 commit，交給使用者確認後自己 commit
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [pluginDir, version] = process.argv.slice(2);
if (!pluginDir || !version) {
  console.error('usage: bump.mjs <plugin-dir> <x.y.z>');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`版本格式錯誤：${version}（需 x.y.z）`);
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const manifestPath = path.join(root, pluginDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`找不到 ${pluginDir}/manifest.json`);
  process.exit(1);
}
const raw = fs.readFileSync(manifestPath, 'utf8');
const hadNewline = raw.endsWith('\n');
const manifest = JSON.parse(raw);
manifest.Version = version;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + (hadNewline ? '\n' : ''));
console.log(`manifest: ${pluginDir}/manifest.json -> ${version}`);

const readmePath = path.join(root, 'README.md');
let readme = fs.readFileSync(readmePath, 'utf8');
const escaped = pluginDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const row = new RegExp(`(^\\|\\s*\`${escaped}\`\\s*\\|\\s*)[0-9]+\\.[0-9]+\\.[0-9]+`, 'm');
if (row.test(readme)) {
  readme = readme.replace(row, `$1${version}`);
  fs.writeFileSync(readmePath, readme);
  console.log(`README: ${pluginDir} -> ${version}`);
} else {
  console.warn(`README 找不到 ${pluginDir} 的版本列，略過`);
}
