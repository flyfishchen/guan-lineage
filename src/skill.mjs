// 把 skills/guan-lineage 安装到 AI 编码助手的 skills 目录，让助手在对话中自动识别并调用 guanlineage。
//
//   guanlineage install-skill [--project] [--agents claude,codex] [--dir <skills 目录>]
//   guanlineage uninstall-skill [--project]
//
// 用户级（默认）：装到 ~/.<助手>/skills，任意目录下打开助手都可用。采用复制（Windows 创建软链接需管理员权限），
//   SKILL.md 更新后需重新运行 install-skill。
// 项目级（--project）：装到本仓库的 .<助手>/skills，只在本项目中打开助手时加载。采用链接（Windows 用目录联接，
//   无需管理员权限），SKILL.md 改动即时生效；链接写入 .git/info/exclude，不进入版本库。
// 两种方式都只装到已安装的助手（其用户级配置目录存在），--agents 可强制指定。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './graph.mjs';

export const SKILL = 'guan-lineage';
const SRC = path.join(ROOT, 'skills', SKILL);

// home：用户级配置目录，环境变量覆盖方式与各助手一致；proj：项目级目录名
// CodeBuddy / WorkBuddy 与观远 guanskill 的安装位置一致
export const AGENTS = [
  { key: 'claude', name: 'Claude Code', proj: '.claude', home: () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude') },
  { key: 'codex', name: 'Codex', proj: '.codex', home: () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex') },
  { key: 'cursor', name: 'Cursor', proj: '.cursor', home: () => path.join(os.homedir(), '.cursor') },
  { key: 'gemini', name: 'Gemini CLI', proj: '.gemini', home: () => path.join(os.homedir(), '.gemini') },
  { key: 'codebuddy', name: 'CodeBuddy', proj: '.codebuddy', home: () => process.env.CODEBUDDY_CONFIG_DIR || path.join(os.homedir(), '.codebuddy') },
  { key: 'workbuddy', name: 'WorkBuddy', proj: '.workbuddy', home: () => process.env.WORKBUDDY_CONFIG_DIR || path.join(os.homedir(), '.workbuddy') },
];

const skillsDir = (a, project) => (project ? path.join(ROOT, a.proj, 'skills') : path.join(a.home(), 'skills'));

// 选出目标：--dir 直接指定 skills 目录；--agents 指定助手（即使未检测到也安装）；默认为已安装的助手
function targets({ agents, dir, project } = {}) {
  if (dir) return [{ name: '自定义目录', dest: path.join(path.resolve(dir), SKILL) }];
  const keys = agents ? String(agents).split(',').map((s) => s.trim().toLowerCase()) : null;
  const unknown = keys?.filter((k) => !AGENTS.some((a) => a.key === k)) || [];
  if (unknown.length) throw new Error(`未知助手：${unknown.join(', ')}（可选 ${AGENTS.map((a) => a.key).join(', ')}）`);
  return AGENTS.filter((a) => (keys ? keys.includes(a.key) : fs.existsSync(a.home()))).map((a) => ({
    name: a.name,
    dest: path.join(skillsDir(a, project), SKILL),
  }));
}

const lstat = (p) => fs.lstatSync(p, { throwIfNoEntry: false });
const isLinkToSrc = (p) => lstat(p)?.isSymbolicLink() && fs.realpathSync(p) === fs.realpathSync(SRC);
// 删除目标：链接（含 Windows 目录联接）只删链接本身，不触及链接指向的仓库源目录
function remove(p) {
  if (lstat(p)?.isSymbolicLink()) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
}

// 先复制到临时目录再替换，失败时恢复原目录，避免留下半个 skill
function replaceDir(src, dest) {
  const parent = path.dirname(dest);
  const tag = `${process.pid}-${Date.now()}`;
  const tmp = path.join(parent, `.${SKILL}.tmp-${tag}`);
  const bak = path.join(parent, `.${SKILL}.bak-${tag}`);
  fs.mkdirSync(parent, { recursive: true });
  fs.cpSync(src, tmp, { recursive: true });
  const had = !!lstat(dest);
  try {
    if (had) fs.renameSync(dest, bak);
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (had && !lstat(dest) && lstat(bak)) fs.renameSync(bak, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  remove(bak);
}

// 链接到仓库源目录：Windows 用目录联接（须绝对路径，无需管理员权限），其它系统用相对软链接（仓库整体移动后仍有效）
function link(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (lstat(dest)) remove(dest);
  if (process.platform === 'win32') fs.symlinkSync(SRC, dest, 'junction');
  else fs.symlinkSync(path.relative(path.dirname(dest), SRC), dest, 'dir');
}

// 项目级链接是本机安装产物，写入 .git/info/exclude 使其不出现在 git status 中
function excludeFromGit(dests) {
  const file = path.join(ROOT, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.dirname(file))) return;
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = new Set(old.split(/\r?\n/));
  const add = dests.map((d) => '/' + path.relative(ROOT, d).split(path.sep).join('/')).filter((l) => !lines.has(l));
  if (add.length) fs.appendFileSync(file, (old && !old.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
}

// 返回 [{ name, dest, status: 'installed' | 'linked' | 'skipped' | 'failed', error? }]
export function installSkill({ agents, dir, project } = {}) {
  if (!fs.existsSync(path.join(SRC, 'SKILL.md'))) throw new Error(`缺少 ${path.join(SRC, 'SKILL.md')}`);
  const rs = targets({ agents, dir, project }).map((t) => {
    try {
      // 已链接到本仓库的（用户自建或此前 --project 安装）保持原样，已是最新
      if (isLinkToSrc(t.dest)) return { ...t, status: 'skipped' };
      if (project) {
        try {
          link(t.dest);
          return { ...t, status: 'linked' };
        } catch {
          // 文件系统不支持链接时退回复制
        }
      }
      replaceDir(SRC, t.dest);
      return { ...t, status: 'installed' };
    } catch (e) {
      return { ...t, status: 'failed', error: e.message };
    }
  });
  if (project) excludeFromGit(rs.filter((r) => r.status !== 'failed').map((r) => r.dest));
  return rs;
}

// 删除所有助手中的 guan-lineage skill（不论当前是否检测到该助手）；--project 删除本仓库内的项目级安装
export function uninstallSkill({ dir, project } = {}) {
  const all = dir ? targets({ dir }) : AGENTS.map((a) => ({ name: a.name, dest: path.join(skillsDir(a, project), SKILL) }));
  return all
    .filter((t) => lstat(t.dest))
    .map((t) => {
      try {
        remove(t.dest);
        return { ...t, status: 'removed' };
      } catch (e) {
        return { ...t, status: 'failed', error: e.message };
      }
    });
}
