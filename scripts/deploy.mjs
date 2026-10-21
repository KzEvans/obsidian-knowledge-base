#!/usr/bin/env node
// Copy the built plugin into a vault: node scripts/deploy.mjs [vault path]
// The vault comes from the argument or PAPER_WORKBENCH_VAULT; nothing is hard-coded.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const vault = process.argv[2] ?? process.env.PAPER_WORKBENCH_VAULT;
if (!vault) {
  console.error('用法：node scripts/deploy.mjs <vault 路径>，或设置 PAPER_WORKBENCH_VAULT。');
  process.exit(2);
}
if (!existsSync(path.join(vault, '.obsidian'))) {
  console.error(`不是 Obsidian vault：${vault}`);
  process.exit(2);
}
if (!existsSync('main.js')) {
  console.error('缺少 main.js，请先运行 pnpm build。');
  process.exit(2);
}

const { id, version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
const target = path.join(vault, '.obsidian', 'plugins', id);
mkdirSync(target, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  if (existsSync(file)) copyFileSync(file, path.join(target, file));
}
console.log(`已部署 ${id} ${version} → ${target}`);
console.log('在 Obsidian 中用 View → Force Reload 重新加载。');
