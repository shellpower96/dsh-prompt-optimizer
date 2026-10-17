/**
 * 项目事实采集：会话工作目录的项目规范文档、Git 分支、会话当前目标。
 *
 * 设计约束：
 * - **只读、有界、绝不抛错**：任一文件读不到就跳过，最坏情况返回空事实，
 *   让优化仍能基于草稿本身完成（“部分降级”优于“整次失败”）。
 * - 不 spawn 子进程：分支从 `.git/HEAD` 直接读，避免 git 调用的耗时与失败面。
 *
 * @module dsh-smartprompt/facts
 */

/** 单份文档最少分配的字符预算，避免 docs 很多时每份只剩几十字。 */
const MIN_DOC_BUDGET = 400;
/** 向上查找 `.git/HEAD` 的最大层数。 */
const MAX_ANCESTORS = 5;

/**
 * 安全读取一个绝对路径的文本；失败一律返回 null。
 *
 * @param {{ resolve: Function, readText: Function } | undefined} fs - `ctx.fs`。
 * @param {string} path - 绝对路径。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @returns {Promise<string | null>} 文本或 null。
 */
async function readTextSafe(fs, path, signal) {
  if (fs === undefined || fs === null) return null;
  try {
    const target = await fs.resolve(path);
    if (target === undefined || target === null) return null;
    const text = await fs.readText(target, signal);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/**
 * 解析 `.git/HEAD` 的内容为可读分支名。
 *
 * @param {string} head - HEAD 文件内容。
 * @returns {string} 分支名，或 `detached <sha8>`；无法识别时返回空串。
 */
export function parseGitHead(head) {
  if (typeof head !== 'string') return '';
  const text = head.trim();
  const ref = text.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (ref !== null) return ref[1].trim();
  if (/^[0-9a-f]{7,40}$/i.test(text)) return `detached ${text.slice(0, 8)}`;
  return '';
}

/**
 * 从 cwd 向上查找 Git 分支。
 *
 * @param {{ resolve: Function, readText: Function } | undefined} fs - `ctx.fs`。
 * @param {string} cwd - 会话工作目录。
 * @param {AbortSignal | undefined} signal - 取消信号。
 * @returns {Promise<string>} 分支名；找不到返回空串。
 */
async function findGitBranch(fs, cwd, signal) {
  if (fs === undefined || fs === null || typeof cwd !== 'string' || cwd.length === 0) return '';
  let dir = cwd.replace(/\/+$/, '');
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    const head = await readTextSafe(fs, `${dir}/.git/HEAD`, signal);
    if (head !== null) return parseGitHead(head);
    const parent = dir.slice(0, dir.lastIndexOf('/'));
    if (parent.length === 0 || parent === dir) break;
    dir = parent;
  }
  return '';
}

/**
 * 采集项目事实。
 *
 * @param {object} input
 * @param {{ resolve: Function, readText: Function } | undefined} input.fs - `ctx.fs`。
 * @param {string | undefined} input.cwd - 会话 cwd（来自 `agent.session.header.cwd`）。
 * @param {readonly string[]} input.docs - 相对 cwd 的文档路径，按顺序读取。
 * @param {number} input.budgetChars - 文档内容的总字符预算。
 * @param {boolean} [input.includeGoal] - 是否带上会话目标。
 * @param {string | undefined} [input.goal] - 会话目标文本。
 * @param {AbortSignal | undefined} [input.signal] - 取消信号。
 * @returns {Promise<{cwd?: string, branch?: string, goal?: string, documents: Array<{path: string, text: string, truncated: boolean}>}>}
 */
export async function collectProjectFacts({ fs, cwd, docs, budgetChars, includeGoal = true, goal, signal }) {
  const facts = { documents: [] };
  if (typeof cwd !== 'string' || cwd.length === 0) return facts;

  facts.cwd = cwd;

  const branch = await findGitBranch(fs, cwd, signal);
  if (branch.length > 0) facts.branch = branch;

  if (includeGoal === true && typeof goal === 'string' && goal.trim().length > 0) {
    facts.goal = goal.trim();
  }

  const list = Array.isArray(docs) ? docs : [];
  if (list.length === 0 || budgetChars <= 0) return facts;

  const perDoc = Math.max(MIN_DOC_BUDGET, Math.floor(budgetChars / list.length));
  let remaining = budgetChars;

  for (const relPath of list) {
    if (remaining <= 0) break;
    if (signal !== undefined && signal.aborted === true) break;
    const text = await readTextSafe(fs, `${cwd.replace(/\/+$/, '')}/${relPath}`, signal);
    if (text === null || text.trim().length === 0) continue;
    const cap = Math.min(perDoc, remaining);
    const sliced = text.length > cap ? text.slice(0, cap) : text;
    facts.documents.push({ path: relPath, text: sliced, truncated: text.length > cap });
    remaining -= sliced.length;
  }

  return facts;
}
