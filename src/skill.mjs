// 把 skills/guan-lineage 安装到本机 AI 编码助手的用户级 skills 目录，让助手在对话中自动识别并调用 guanlineage。
//
//   guanlineage install-skill [--agents claude,codex] [--dir <skills 目录>]
//   guanlineage uninstall-skill
//
// 只安装到已安装的助手（其配置目录存在）；复制而非软链接（Windows 创建软链接需要管理员权限），
// 因此 SKILL.md 更新后需重新运行 install-skill（install.sh / install.cmd 会自动执行）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './graph.mjs';

export const SKILL = 'guan-lineage';
const SRC = path.join(ROOT, 'skills', SKILL);

// 配置目录与环境变量覆盖方式与各助手保持一致；CodeBuddy / WorkBuddy 与观远 guanskill 的安装位置一致
export const AGENTS = [
  { key: 'claude', name: 'Claude Code', home: () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') },
  { key: 'codex', name: 'Codex', home: () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex') },
  { key: 'cursor', name: 'Cursor', home: () => path.join(os.homedir(), '.cursor') },
  { key: 'gemini', name: 'Gemini CLI', home: () => path.join(os.homedir(), '.gemini') },
  { key: 'codebuddy', name: 'CodeBuddy', home: () => process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy') },
  { key: 'workbuddy', name: 'WorkBuddy', home: () => process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy') },
];

// 选出目标：--dir 直接指定 skills 目录；--agents 指定助手（即使未检测到也安装）；默认为已安装的助手
function targets({ agents, dir } = {}) {
  if (dir) return [{ name: '自定义目录', dest: path.join(path.resolve(dir), SKILL) }];
  const keys = agents ? String(agents).split(',').map((s) => s.trim().toLowerCase()) : null;
  const unknown = keys?.filter((k) => !AGENTS.some((a) => a.key === k)) || [];
  if (unknown.length) throw new Error(`未知助手：${unknown.join(', ')}（可选 ${AGENTS.map((a) => a.key).join(', ')}）`);
  return AGENTS.filter((a) => (keys ? keys.includes(a.key) : fs.existsSync(a.home()))).map((a) => ({
    name: a.name,
    dest: path.join(a.home(), 'skills', SKILL),
  }));
}

// 先复制到临时目录再替换，失败时恢复原目录，避免留下半个 skill
function replaceDir(src, dest) {
  const parent = path.dirname(dest);
  const tag = `${process.pid}-${Date.now()}`;
  const tmp = path.join(parent, `.${SKILL}.tmp-${tag}`);
  const bak = path.join(parent, `.${SKILL}.bak-${tag}`);
  fs.mkdirSync(parent, { recursive: true });
  fs.cpSync(src, tmp, { recursive: true });
  const had = fs.existsSync(dest);
  try {
    if (had) fs.renameSync(dest, bak);
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (had && !fs.existsSync(dest) && fs.existsSync(bak)) fs.renameSync(bak, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  fs.rmSync(bak, { recursive: true, force: true });
}

// 返回 [{ name, dest, status: 'installed' | 'linked' | 'failed', error? }]
export function installSkill(opts = {}) {
  if (!fs.existsSync(path.join(SRC, 'SKILL.md'))) throw new Error(`缺少 ${path.join(SRC, 'SKILL.md')}`);
  return targets(opts).map((t) => {
    try {
      // 用户自行软链接到本仓库的，保持原样（已是最新）
      if (fs.lstatSync(t.dest, { throwIfNoEntry: false })?.isSymbolicLink() && fs.realpathSync(t.dest) === fs.realpathSync(SRC))
        return { ...t, status: 'linked' };
      replaceDir(SRC, t.dest);
      return { ...t, status: 'installed' };
    } catch (e) {
      return { ...t, status: 'failed', error: e.message };
    }
  });
}

// 删除所有助手中的 guan-lineage skill（不论当前是否检测到该助手）
export function uninstallSkill({ dir } = {}) {
  const all = dir ? targets({ dir }) : AGENTS.map((a) => ({ name: a.name, dest: path.join(a.home(), 'skills', SKILL) }));
  return all
    .filter((t) => fs.lstatSync(t.dest, { throwIfNoEntry: false }))
    .map((t) => {
      try {
        fs.rmSync(t.dest, { recursive: true, force: true });
        return { ...t, status: 'removed' };
      } catch (e) {
        return { ...t, status: 'failed', error: e.message };
      }
    });
}
