import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where CLIs are usually installed; Obsidian started from the Dock does not inherit the shell PATH. */
export function probeDirs(home = os.homedir()): string[] {
  return [path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export function isExecutable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return true; }
  catch { return false; }
}

/** The configured path wins; otherwise the first probe directory that has the CLI. */
export function resolveCli(name: string, configured: string, options: { home?: string; exists?: (file: string) => boolean } = {}): string {
  const exists = options.exists ?? isExecutable;
  const home = options.home ?? os.homedir();
  const setting = configured.trim().replace(/^~(?=\/|$)/, home);
  if (setting) {
    if (!exists(setting)) throw new Error(`设置中的 ${name} 路径不可执行：${setting}`);
    return setting;
  }
  for (const dir of probeDirs(home)) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  throw new Error(`未找到 ${name}。请在设置中填写路径，或安装到 ${probeDirs(home).join('、')} 之一。`);
}

/** Child environment: complete PATH and, when set, the proxy for every common variable. */
export function childEnv(base: NodeJS.ProcessEnv, cli: string, proxyUrl: string, home = os.homedir()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const dirs = [path.dirname(cli), ...probeDirs(home), ...SYSTEM_DIRS, ...(base.PATH ?? '').split(':')];
  env.PATH = [...new Set(dirs.filter(Boolean))].join(':');
  const proxy = proxyUrl.trim();
  if (proxy) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = proxy;
    const noProxy = [...new Set(['localhost', '127.0.0.1', '::1', ...(base.NO_PROXY ?? base.no_proxy ?? '').split(',').map(item => item.trim())].filter(Boolean))].join(',');
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return env;
}
