const app = document.getElementById('app');
const account = document.getElementById('account');
const POLL_MS = 1500;
let pollTimer = null;
let me = null;
// Re-renders replace the DOM, so typed input, errors and open lists live here to survive polling.
const draft = { source: '', target: '', password: '', error: '' };
const openNodeLists = new Set();
const openTrees = new Set();

const TYPE_LABELS = {
  docx: '文档',
  doc: '旧版文档',
  sheet: '电子表格',
  bitable: '多维表格',
  file: '文件',
  folder: '文件夹',
  mindnote: '思维笔记',
  slides: '幻灯片',
};
const STATUS_LABELS = {
  running: '进行中',
  pending: '等待中',
  reading: '读取中',
  pausing: '暂停中',
  paused: '已暂停',
  created: '已建节点',
  done: '已完成',
  partial: '部分失败',
  failed: '失败',
  placeholder: '仅占位',
  writing: '处理中',
  interrupted: '已中断',
  unsupported: '不支持',
  scanning: '对比中',
  scanned: '对比完成',
  applying: '补全中',
  missing: '待补全',
  mismatch: '需手动处理',
  complete: '无需补全',
  fixed: '已补全',
};
const STAT_LABELS = {
  blocks: '内容块',
  images: '图片',
  files: '附件',
  skipped: '未下载的素材',
  boards: '画板',
  embeds: '内嵌表格',
  sheets: '工作表',
  tables: '数据表',
  fields: '字段',
  records: '记录',
  attachments: '附件',
};
const LOGIN_ERRORS = {
  denied: '你取消了 Lark 授权。',
  state: '授权已过期或来源不正确，请重新操作。',
  failed: 'Lark 授权没有成功。如果多次失败，请联系管理员检查机器人的权限和重定向 URL。',
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isActive = (status) => status === 'running' || status === 'pausing';
const canContinue = (status) => status === 'paused' || status === 'interrupted' || status === 'failed';
const typeLabel = (type) => TYPE_LABELS[type] || type;
const badge = (status) => `<span class="badge ${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
const formatTime = (ms) => new Date(ms).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  const data = await res.json();
  if (res.status === 401 && path !== '/api/auth/admin') {
    me = null;
    location.hash = '#/login';
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function schedule(fn, active) {
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(fn, POLL_MS);
}

function renderInPlace(html) {
  // Preserve focus and caret when polling redraws a form the user is typing in.
  const focused = document.activeElement;
  const focusId = focused?.id;
  const caret = focused?.selectionStart;
  app.innerHTML = html;
  if (focusId) {
    const next = document.getElementById(focusId);
    next?.focus();
    if (caret !== undefined && caret !== null) next?.setSelectionRange?.(caret, caret);
  }
}

// A real dialog rather than confirm(), so long explanations stay readable.
function confirmDialog(title, lines, action) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = `
      <h2>${esc(title)}</h2>
      ${lines.map((line) => `<p>${esc(line)}</p>`).join('')}
      <div class="dialog-actions">
        <button class="secondary" value="">取消</button>
        <button value="ok">${esc(action)}</button>
      </div>`;
    dialog.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) dialog.close(button.value);
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'ok');
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

function renderAccount() {
  if (!me?.role) {
    account.innerHTML = '';
    return;
  }
  const nav = me.role === 'admin'
    ? `<a href="#/">我的迁移</a><a href="#/repair">补全图表</a><a href="#/members">团队成员</a>`
    : '';
  account.innerHTML = `
    <nav class="nav">${nav}</nav>
    <span class="who">${esc(me.name)}</span>
    <button class="link-button" data-action="logout">退出</button>`;
}

function showLogin() {
  const code = location.hash.match(/error=(\w+)/)?.[1];
  renderInPlace(`
    <section class="login">
      <h1>Lark 文档迁移</h1>
      <p class="sub">把你的文档库和云空间迁移到新组织，目录结构保持不变。</p>
      ${code && LOGIN_ERRORS[code] ? `<p class="error">${esc(LOGIN_ERRORS[code])}</p>` : ''}
      ${me?.memberEnabled === false ? '<p class="hint">管理员还没有配置 Lark 机器人。</p>' : '<a class="button wide" href="/api/auth/lark/login">使用 Lark 账号登录</a>'}
      <p class="hint">登录后，工具只能读取你本人的文档库和云空间（我的空间）。</p>
      ${me?.adminEnabled ? `
        <form id="admin-login" class="admin-login">
          <label for="admin-password">管理员登录</label>
          <div class="form-row">
            <input id="admin-password" type="password" required autocomplete="current-password" placeholder="管理员密码" />
            <button class="secondary" type="submit">登录</button>
          </div>
          ${draft.error ? `<p class="error">${esc(draft.error)}</p>` : ''}
        </form>` : ''}
    </section>
  `);
  document.getElementById('admin-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/admin', { password: document.getElementById('admin-password').value });
      draft.error = '';
      location.hash = '#/';
      await route();
    } catch (err) {
      draft.error = err.message;
      showLogin();
    }
  });
}

function jobRow(job) {
  const types = Object.entries(job.byType).map(([type, n]) => `${typeLabel(type)} ${n}`).join(' · ');
  return `
    <a class="job" href="#/exports/${job.id}">
      <div>
        <div class="job-title">${esc(job.root_title || job.source_url)}</div>
        <div class="job-meta">共 ${job.total} 个节点${types ? `：${esc(types)}` : ''} · ${esc(formatTime(job.created_at))}</div>
      </div>
      ${badge(job.status)}
    </a>`;
}

async function showAdminHome() {
  const jobs = await api('/api/exports');
  renderInPlace(`
    <h1>我的迁移</h1>
    <p class="sub">输入知识库链接，程序会用机器人读取它和所有子文档。</p>
    <section class="panel">
      <form id="start" class="form-row">
        <input id="source-url" type="url" required value="${esc(draft.source)}"
          placeholder="https://xxx.larksuite.com/wiki/..." aria-label="源文档链接" />
        <button type="submit">开始读取</button>
      </form>
      ${draft.error ? `<p class="error">${esc(draft.error)}</p>` : ''}
    </section>
    <section class="panel">
      <h2>读取记录</h2>
      ${jobs.length ? jobs.map(jobRow).join('') : '<p class="hint">还没有读取记录。</p>'}
    </section>
  `);
  document.getElementById('source-url').addEventListener('input', (e) => { draft.source = e.target.value; });
  document.getElementById('start').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { id } = await api('/api/exports', { url: draft.source });
      draft.source = '';
      draft.error = '';
      location.hash = `#/exports/${id}`;
    } catch (err) {
      draft.error = err.message;
      showAdminHome();
    }
  });
  schedule(route, jobs.some((job) => isActive(job.status)));
}

async function showRepair() {
  const repairs = await api('/api/admin/repairs');
  renderInPlace(`
    <h1>补全图表</h1>
    <p class="sub">之前的版本迁移时，Mermaid 图等扩展组件被换成了“[未迁移的内容: 扩展组件]”。这里按源文档把它们补回原来的位置，不用重新迁移。</p>
    <section class="panel">
      <form id="repair">
        <label class="field">源文档链接（旧组织）
          <input id="repair-source" type="url" required value="${esc(draft.repairSource ?? '')}" placeholder="https://xxx.larksuite.com/wiki/..." />
        </label>
        <label class="field">迁移后的文档链接（新组织）
          <input id="repair-target" type="url" required value="${esc(draft.repairTarget ?? '')}" placeholder="https://yyy.larksuite.com/wiki/..." />
        </label>
        <p class="hint">两个链接是同一篇文档迁移前后的位置，下面的子文档按标题一一对应。先对比，只读不写；确认结果后再补全。</p>
        <div class="actions"><button type="submit">开始对比</button></div>
      </form>
      ${draft.error ? `<p class="error">${esc(draft.error)}</p>` : ''}
    </section>
    ${repairs.map(repairPanel).join('')}
  `);
  for (const [id, key] of [['repair-source', 'repairSource'], ['repair-target', 'repairTarget']]) {
    document.getElementById(id).addEventListener('input', (e) => { draft[key] = e.target.value; });
  }
  document.getElementById('repair').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/repairs', { sourceUrl: draft.repairSource ?? '', targetUrl: draft.repairTarget ?? '' });
      draft.repairSource = '';
      draft.repairTarget = '';
      draft.error = '';
    } catch (err) {
      draft.error = err.message;
    }
    showRepair();
  });
  schedule(route, repairs.some((r) => r.status === 'scanning' || r.status === 'applying'));
}

function repairPanel(r) {
  const sum = (key) => r.docs.reduce((total, doc) => total + (doc[key] ?? 0), 0);
  const byState = (state) => r.docs.filter((doc) => doc.state === state).length;
  const toFix = r.docs.filter((doc) => doc.state === 'missing' || doc.state === 'failed');
  const canApply = (r.status === 'scanned' || r.status === 'partial') && toFix.length;
  const progress = r.status === 'scanning'
    ? `已配对 ${r.progress.paired} 个节点 · 已检查 ${r.progress.checked} 篇文档`
    : `${r.docs.length} 篇文档有图表，共 ${sum('diagrams')} 张 · 待补 ${sum('missing')} 张 · 已补 ${sum('restored')} 张${byState('mismatch') ? ` · ${byState('mismatch')} 篇需手动处理` : ''}`;
  const unmatched = r.progress.unmatched ?? [];
  return `
    <section class="panel">
      <div class="spread">
        <p class="facts">
          <a href="${esc(r.source_url)}" target="_blank" rel="noreferrer">${esc(r.source_url)}</a><br />
          → <a href="${esc(r.target_url)}" target="_blank" rel="noreferrer">${esc(r.target_url)}</a><br />
          ${esc(formatTime(r.created_at))}
        </p>
        ${badge(r.status)}
      </div>
      ${r.error ? `<p class="error">${esc(r.error)}</p>` : ''}
      <p class="hint">${esc(progress)}</p>
      ${canApply ? `<div class="actions"><button data-action="apply-repair" data-target="${r.id}">补上 ${toFix.reduce((t, doc) => t + (doc.missing || 0), 0)} 张图</button></div>` : ''}
      ${r.docs.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>文档</th><th>图表</th><th>待补</th><th>状态</th></tr></thead>
            <tbody>${r.docs.map((doc) => `
              <tr>
                <td>
                  ${esc(doc.path)}
                  <div class="hint-inline"><a href="${esc(doc.sourceUrl)}" target="_blank" rel="noreferrer">源文档</a> · <a href="${esc(doc.targetUrl)}" target="_blank" rel="noreferrer">新文档</a></div>
                  ${doc.state === 'mismatch' ? `<div class="note">新文档里有 ${doc.slots} 处图表或占位，源文档有 ${doc.diagrams} 张图，位置对不上，需要手动补</div>` : ''}
                  ${doc.error ? `<div class="note bad">${esc(doc.error)}</div>` : ''}
                </td>
                <td class="number">${doc.diagrams ?? '-'}</td>
                <td class="number">${doc.missing ?? '-'}</td>
                <td>${badge(doc.state)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
      ${unmatched.length ? `
        <details class="unmatched">
          <summary>${unmatched.length} 个源节点在新位置找不到同名节点，已跳过</summary>
          ${unmatched.map((path) => `<div class="hint-inline">${esc(path)}</div>`).join('')}
        </details>` : ''}
    </section>`;
}

const statusCell = (status) => (status ? badge(status) : '<span class="hint-inline">未开始</span>');

async function showMembers() {
  const members = await api('/api/admin/members');
  renderInPlace(`
    <h1>团队成员</h1>
    <p class="sub">这里只显示迁移状态和数量，看不到成员的文档标题和内容。</p>
    <section class="panel">
      ${members.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>成员</th><th>读取</th><th>节点数</th><th>新组织授权</th><th>迁移</th><th>已完成</th><th>失败</th><th>最近开始</th></tr></thead>
            <tbody>${members.map((member) => `
              <tr>
                <td>${esc(member.name || '未命名')}</td>
                <td>${statusCell(member.read?.status)}</td>
                <td class="number">${member.read?.total ?? '-'}</td>
                <td>${member.targetAuthorized ? '已授权' : '<span class="hint-inline">未授权</span>'}</td>
                <td>${statusCell(member.migration?.status)}</td>
                <td class="number">${member.migration ? `${member.migration.counts.done} / ${member.migration.counts.total}` : '-'}</td>
                <td class="number">${(member.migration?.counts.failed ?? 0) + (member.read?.failed ?? 0) || '-'}</td>
                <td>${esc(formatTime(member.migration?.createdAt ?? member.read?.createdAt ?? member.firstSeenAt))}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<p class="hint">还没有成员登录过。</p>'}
    </section>
  `);
  schedule(route, members.some((m) => isActive(m.read?.status) || isActive(m.migration?.status)));
}

function readSummary(job) {
  const finished = (job.byStatus.done || 0) + (job.byStatus.unsupported || 0) + (job.byStatus.failed || 0);
  const totals = Object.entries(job.totals)
    .filter(([key, value]) => STAT_LABELS[key] && value)
    .map(([key, value]) => `${STAT_LABELS[key]} ${value}`)
    .join(' · ');
  return `
    <div class="tiles">
      <div class="tile"><div class="tile-value">${job.total}</div><div class="tile-label">节点总数</div></div>
      ${Object.entries(job.byType).map(([type, n]) => `
        <div class="tile"><div class="tile-value">${n}</div><div class="tile-label">${esc(typeLabel(type))}</div></div>
      `).join('')}
      <div class="tile"><div class="tile-value">${formatBytes(job.assetBytes)}</div><div class="tile-label">图片和附件 (${job.assetCount})</div></div>
    </div>
    <p class="facts">已读取 ${finished} / ${job.total}${totals ? ` · ${esc(totals)}` : ''}</p>`;
}

function readActions(job) {
  const failedCount = job.byStatus.failed || 0;
  return `
    <div class="actions">
      ${job.status === 'running' ? '<button class="secondary" data-action="pause-export">暂停</button>' : ''}
      ${job.status === 'pausing' ? `<button class="secondary" disabled>暂停中…</button>
        <span class="hint-inline">${job.phase === 'tree' ? '目录读取完成后暂停' : '正在处理的文档完成后暂停'}</span>` : ''}
      ${canContinue(job.status) ? '<button data-action="resume-export">继续</button>' : ''}
      ${failedCount && !isActive(job.status) ? `<button class="secondary" data-action="retry-failed">重试全部失败的文档 (${failedCount})</button>` : ''}
    </div>`;
}

function failedSection(job) {
  const failed = job.nodes.filter((node) => node.status === 'failed');
  if (!failed.length) return '';
  return `
    <h3>读取失败的文档 (${failed.length})</h3>
    <ul class="tree">${failed.map((node) => nodeRow({ ...node, depth: 0 })).join('')}</ul>`;
}

function treeSection(job) {
  const open = openTrees.has(String(job.id));
  return `
    <section class="panel">
      <button class="link-button" data-action="toggle-tree" data-target="${job.id}">${open ? '收起文档结构' : `查看文档结构 (${job.total})`}</button>
      ${open ? `<ul class="tree">${job.nodes.map(nodeRow).join('')}</ul>` : ''}
    </section>`;
}

function dangerSection(job) {
  const busy = isActive(job.status) || job.migrations.some((m) => isActive(m.status));
  return `
    <div class="footer-actions">
      <button class="link-button danger" data-action="delete-export" ${busy ? 'disabled' : ''}>删除服务器上的这份数据</button>
    </div>`;
}

function step(number, title, state, body) {
  return `
    <section class="panel step ${state}">
      <div class="step-number">${state === 'done' ? '✓' : number}</div>
      <div class="step-body">
        <h2>${esc(title)}</h2>
        ${body}
      </div>
    </section>`;
}

function readStep(job) {
  if (!job) {
    return step(1, '读取我的文档库和云空间', 'current', `
      <p class="hint">读取你在当前组织的整个文档库，以及云空间“我的空间”里的文件夹和文件，内容会暂存在这台服务器上。不会修改原文档。</p>
      <div class="actions"><button data-action="start-library">开始读取</button></div>`);
  }
  const finished = !isActive(job.status) && job.tree_complete && !job.byStatus.pending && !job.byStatus.reading;
  return step(1, '读取我的文档库和云空间', finished ? 'done' : 'current', `
    <div class="spread"><span class="hint-inline">${esc(formatTime(job.created_at))}</span>${badge(job.status)}</div>
    ${job.error ? `<p class="error">${esc(job.error)}</p>` : ''}
    ${readSummary(job)}
    ${readActions(job)}
    ${failedSection(job)}
    ${isActive(job.status) ? '' : '<div class="actions"><button class="link-button" data-action="start-library">重新读取最新内容</button></div>'}`);
}

function authorizeStep() {
  if (!me.targetEnabled) {
    return step(2, '授权新组织', 'waiting', '<p class="hint">管理员还没有配置新组织的机器人，暂时无法继续。</p>');
  }
  if (me.target) {
    return step(2, '授权新组织', 'done', `
      <p class="facts">已授权账号：${esc(me.target.name || '未命名')}</p>
      <div class="actions">
        <a class="link-button" href="/api/auth/lark/target">更换账号</a>
        <button class="link-button" data-action="revoke-target">取消授权</button>
      </div>`);
  }
  return step(2, '授权新组织', 'current', `
    <p class="hint">用你在新组织的 Lark 账号登录，内容会写到这个账号的文档库和云空间。</p>
    <div class="actions"><a class="button" href="/api/auth/lark/target">授权新组织</a></div>`);
}

function writeStep(job) {
  const finished = job && !isActive(job.status) && job.tree_complete && !job.byStatus.pending && !job.byStatus.reading;
  const migrating = job?.migrations.some((m) => isActive(m.status));
  const ready = finished && me.target && !migrating;
  const done = job?.migrations[0]?.status === 'done';
  return step(3, '写入新组织', done ? 'done' : ready ? 'current' : 'waiting', `
    <p class="hint">内容会写到${me.target ? `「${esc(me.target.name)}」` : '你'}在新组织的文档库顶层；云空间的内容放在新账号云空间里一个名为“我的空间”的文件夹中。不会覆盖已有内容。</p>
    ${draft.error ? `<p class="error">${esc(draft.error)}</p>` : ''}
    <div class="actions"><button data-action="start-library-migration" ${ready ? '' : 'disabled'}>${job?.migrations.length ? '再次写入' : '开始写入'}</button></div>
    ${(job?.migrations ?? []).map(migrationBlock).join('')}`);
}

async function showMemberHome(requestedId) {
  const jobs = await api('/api/exports');
  const id = requestedId ?? jobs[0]?.id;
  const job = id ? await api(`/api/exports/${id}`) : null;
  const older = jobs.filter((other) => other.id !== job?.id);
  renderInPlace(`
    <h1>迁移我的文档库和云空间</h1>
    <p class="sub">按顺序完成下面三步。</p>
    ${readStep(job)}
    ${authorizeStep()}
    ${writeStep(job)}
    ${job ? treeSection(job) : ''}
    ${older.length ? `<section class="panel"><h2>其他读取记录</h2>${older.map(jobRow).join('')}</section>` : ''}
    ${job ? dangerSection(job) : ''}
  `);
  schedule(route, Boolean(job) && (isActive(job.status) || job.migrations.some((m) => isActive(m.status)) || (job.byStatus.reading || 0) > 0));
}

async function showAdminExport(id) {
  const job = await api(`/api/exports/${id}`);
  const migrating = job.migrations.some((m) => isActive(m.status));
  const unread = (job.byStatus.pending || 0) + (job.byStatus.reading || 0);
  renderInPlace(`
    <div class="spread">
      <div>
        <h1>${esc(job.root_title || (job.status === 'running' ? '读取中…' : '未读取到文档'))}</h1>
        <p class="sub"><a href="${esc(job.source_url)}" target="_blank" rel="noreferrer">${esc(job.source_url)}</a></p>
      </div>
      ${badge(job.status)}
    </div>
    ${job.error ? `<section class="panel"><p class="error">${esc(job.error)}</p></section>` : ''}
    <section class="panel">
      ${readSummary(job)}
      ${readActions(job)}
      ${failedSection(job)}
    </section>
    <section class="panel">
      <h2>写回到另一个位置</h2>
      <form id="migrate" class="form-row">
        <input id="target-url" type="url" required value="${esc(draft.target)}"
          placeholder="目标知识库节点链接，它会变成源目录的第一层" aria-label="目标文档链接" />
        <button type="submit" ${isActive(job.status) || migrating || !job.tree_complete || unread ? 'disabled' : ''}>开始迁移</button>
      </form>
      ${unread && !isActive(job.status) ? `<p class="hint">还有 ${unread} 个文档没有读取完，继续读取后才能迁移。</p>` : ''}
      ${draft.error ? `<p class="error">${esc(draft.error)}</p>` : ''}
      ${job.migrations.map(migrationBlock).join('')}
    </section>
    ${treeSection(job)}
    ${dangerSection(job)}
  `);

  document.getElementById('target-url').addEventListener('input', (e) => { draft.target = e.target.value; });
  document.getElementById('migrate').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const preview = await api(`/api/exports/${id}/migration-preview`, { url: draft.target });
      const lines = describeMigration(job, preview);
      if (job.byStatus.failed) lines.push(`注意：有 ${job.byStatus.failed} 个节点读取失败，迁移后只有占位文档。建议先重试读取。`);
      if (!(await confirmDialog('确认开始迁移？', lines, '开始迁移'))) return;
      await api(`/api/exports/${id}/migrations`, { url: draft.target });
      draft.error = '';
    } catch (err) {
      draft.error = err.message;
    }
    route();
  });
  schedule(route, isActive(job.status) || migrating || (job.byStatus.reading || 0) > 0);
}

// Handled by delegation: polling replaces these buttons, and a click landing across
// a redraw would be lost if the listener lived on the button itself.
const ACTIONS = {
  logout: async () => {
    await api('/api/auth/logout', {});
    me = null;
    location.hash = '#/login';
  },
  'start-library': async () => {
    const { id } = await api('/api/library/export', {});
    location.hash = `#/exports/${id}`;
  },
  'start-library-migration': async ({ exportId }) => {
    const job = await api(`/api/exports/${exportId}`);
    const lines = [
      `将把 ${job.total} 个节点写到「${me.target.name}」在新组织的文档库和云空间。`,
      '已有内容不会被覆盖。',
    ];
    if (job.migrations.length) lines.push('这份内容已经写入过，再次写入会产生重复的文档。');
    if (job.byStatus.failed) lines.push(`有 ${job.byStatus.failed} 个节点读取失败，迁移后只有占位文档。建议先重试读取。`);
    if (await confirmDialog('确认写入新组织？', lines, '开始写入')) {
      await api(`/api/exports/${exportId}/library-migration`, {});
    }
  },
  'revoke-target': async () => {
    if (await confirmDialog('取消新组织授权？', ['工具会删除保存的授权。之后要写入新组织需要重新授权。'], '取消授权')) {
      await api('/api/auth/lark/target/revoke', {});
    }
  },
  'delete-export': async ({ exportId }) => {
    const lines = ['会删除这次读取保存在服务器上的文档内容、图片和附件，以及对应的迁移记录。', 'Lark 里的文档不受影响。这个操作不能撤销。'];
    if (await confirmDialog('删除这份数据？', lines, '删除')) {
      await api(`/api/exports/${exportId}/delete`, {});
      location.hash = '#/';
    }
  },
  'apply-repair': async ({ target }) => {
    const lines = [
      '会在新文档中把“[未迁移的内容: 扩展组件]”替换成源文档里对应的图表，其余内容不变。',
      '标为“需手动处理”的文档不会改动。',
    ];
    if (await confirmDialog('补全这些图表？', lines, '开始补全')) {
      await api(`/api/admin/repairs/${target}/apply`, {});
    }
  },
  'pause-export': ({ exportId }) => api(`/api/exports/${exportId}/pause`, {}),
  'resume-export': ({ exportId }) => api(`/api/exports/${exportId}/resume`, {}),
  'retry-failed': ({ exportId }) => api(`/api/exports/${exportId}/resume`, { retryFailed: true }),
  'retry-node': ({ exportId, target }) => api(`/api/exports/${exportId}/nodes/${target}/retry`, {}),
  'pause-migration': ({ target }) => api(`/api/migrations/${target}/pause`, {}),
  'resume-migration': ({ target }) => api(`/api/migrations/${target}/resume`, {}),
  'toggle-nodes': ({ target }) => {
    if (!openNodeLists.delete(target)) openNodeLists.add(target);
  },
  'toggle-tree': ({ target }) => {
    if (!openTrees.delete(target)) openTrees.add(target);
  },
};

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  try {
    // A member's home page shows their latest read without naming it in the address.
    const named = location.hash.match(/^#\/exports\/(\d+)/)?.[1];
    const exportId = named ?? (me?.role === 'member' ? (await api('/api/exports'))[0]?.id : undefined);
    await ACTIONS[button.dataset.action]({ exportId, target: button.dataset.target });
    draft.error = '';
  } catch (err) {
    draft.error = err.message;
  }
  route();
});

function describeMigration(job, preview) {
  const lines = [];
  if (preview.overwrite) {
    lines.push(`目标文档「${preview.targetTitle}」会改名为「${preview.rootTitle}」。`);
    if (preview.bodyBlocks) lines.push(`它现有的正文（${preview.bodyBlocks} 个内容块）会被覆盖，之后只能尝试从 Lark 文档的历史记录中找回。`);
    lines.push(`其余 ${job.total - 1} 个节点会写到它下面，层级保持不变。`);
  } else {
    const reason = preview.rootType !== 'docx' || preview.targetType !== 'docx'
      ? `只有文档之间才能合并（源是 ${typeLabel(preview.rootType)}，目标是 ${typeLabel(preview.targetType)}）`
      : '源文档没有读取成功';
    lines.push(`${reason}，所以「${preview.rootTitle}」会作为子节点写到「${preview.targetTitle}」下面，共 ${job.total} 个节点。`);
  }
  if (preview.childCount) lines.push(`目标下已有的 ${preview.childCount} 个子节点会保留，新内容排在它们后面。`);
  return lines;
}

function nodeRow(node) {
  const stats = Object.entries(node.stats)
    .filter(([key, value]) => STAT_LABELS[key] && value)
    .map(([key, value]) => `${STAT_LABELS[key]} ${value}`)
    .join(' · ');
  const shortcut = node.node_type === 'shortcut' ? '快捷方式 · ' : '';
  return `
    <li class="tree-row" style="padding-left:${node.depth * 20}px">
      <div class="tree-main">
        <span class="tree-title">${esc(node.title || '未命名')}</span>
        <span class="tree-type">${shortcut}${esc(typeLabel(node.obj_type))}</span>
        ${stats ? `<div class="tree-stats">${esc(stats)}</div>` : ''}
        ${node.error ? `<div class="note bad">${esc(node.error)}</div>` : ''}
        ${node.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join('')}
      </div>
      ${node.status === 'failed' ? `<button class="secondary small" data-action="retry-node" data-target="${node.id}">重试</button>` : ''}
      ${badge(node.status)}
    </li>`;
}

function stage(number, label, done, total, state) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return `
    <div class="stage ${state}">
      <div class="spread"><span>${number}. ${label}</span><span class="stage-count">${done} / ${total}</span></div>
      <div class="progress"><div style="width:${percent}%"></div></div>
    </div>`;
}

function stages(m) {
  const { structure, content } = m.progress;
  const running = isActive(m.status);
  return `
    <div class="stages">
      ${stage(1, '建目录', structure, m.counts.total, running && m.phase === 'structure' ? 'current' : '')}
      ${stage(2, '写内容', content, m.counts.total, running && m.phase === 'content' ? 'current' : '')}
    </div>`;
}

function progressFacts(m) {
  const { elapsedMs, ratePerSecond, etaMs, concurrency, byType } = m.progress;
  const facts = [`用时 ${formatDuration(elapsedMs)}`];
  if (isActive(m.status) && etaMs !== null) {
    facts.push(`当前阶段还需约 ${formatDuration(etaMs)}`, `${ratePerSecond.toFixed(1)} 个/秒`);
  }
  if (isActive(m.status)) facts.push(`并发 ${concurrency}`);
  const types = Object.entries(byType).map(([type, { done, total }]) => `${typeLabel(type)} ${done}/${total}`);
  return `<p class="facts">${esc(facts.join(' · '))}</p><p class="facts">${esc(types.join(' · '))}</p>`;
}

const stepText = ({ step, done, total }) => (total ? `${step} ${done}/${total}` : step);

function activeList(m) {
  const { active } = m.progress;
  if (!active.length) return '';
  return `
    <h3>正在处理 (${active.length})</h3>
    ${active.map((entry) => `
      <div class="tree-row">
        <div class="tree-main">
          <span class="tree-title">${esc(entry.title || '未命名')}</span>
          <span class="tree-type">${esc(typeLabel(entry.objType))}</span>
          <div class="tree-stats">${esc(stepText(entry))}</div>
        </div>
        <span class="duration">${esc(formatDuration(entry.ms))}</span>
      </div>`).join('')}`;
}

function nodeList(m) {
  const open = openNodeLists.has(String(m.id));
  const active = new Map(m.progress.active.map((entry) => [entry.nodeId, entry]));
  const rows = !open ? '' : m.items.map((item) => {
    const current = active.get(item.node_id);
    return `
      <div class="tree-row" style="padding-left:${item.depth * 20}px">
        <div class="tree-main">
          <span class="tree-title">${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(item.title)}</a>` : esc(item.title)}</span>
          <span class="tree-type">${esc(typeLabel(item.obj_type))}</span>
          ${current ? `<div class="tree-stats">${esc(stepText(current))}</div>` : ''}
        </div>
        ${item.duration_ms ? `<span class="duration">${esc(formatDuration(item.duration_ms))}</span>` : ''}
        ${badge(current ? 'writing' : item.status)}
      </div>`;
  }).join('');
  return `
    <button class="link-button" data-action="toggle-nodes" data-target="${m.id}">${open ? '收起节点列表' : `查看全部节点 (${m.counts.total})`}</button>
    ${rows}`;
}

function migrationBlock(m) {
  const notable = m.items.filter((item) => item.status === 'failed' || item.status === 'placeholder' || item.warnings.length);
  const root = m.items.find((item) => item.url);
  const destination = m.target_url
    ? `<a href="${esc(m.target_url)}" target="_blank" rel="noreferrer">${esc(m.target_url)}</a>`
    : '新组织的文档库和云空间';
  return `
    <div class="migration">
      <div class="spread">
        <div class="job-meta">写入 #${m.id} → ${destination}</div>
        ${badge(m.status)}
      </div>
      ${stages(m)}
      ${progressFacts(m)}
      <p class="facts">完成 ${m.counts.done} / ${m.counts.total}${m.counts.failed ? ` · 失败 ${m.counts.failed}` : ''}${m.counts.placeholder ? ` · 仅占位 ${m.counts.placeholder}` : ''}
        ${root && !isActive(m.status) ? ` · <a href="${esc(root.url)}" target="_blank" rel="noreferrer">打开迁移结果</a>` : ''}</p>
      ${m.error ? `<p class="error">${esc(m.error)}</p>` : ''}
      <div class="actions">
        ${m.status === 'running' ? `<button class="secondary" data-action="pause-migration" data-target="${m.id}">暂停</button>` : ''}
        ${m.status === 'pausing' ? `<button class="secondary" disabled>暂停中…</button>
          <span class="hint-inline">正在处理的文档完成后暂停</span>` : ''}
        ${m.status === 'paused' || m.status === 'interrupted' ? `<button data-action="resume-migration" data-target="${m.id}">继续</button>` : ''}
        ${m.status === 'partial' || m.status === 'failed' ? `<button class="secondary" data-action="resume-migration" data-target="${m.id}">重试未完成的节点</button>` : ''}
      </div>
      ${notable.map((item) => `
        <div class="tree-row">
          <div class="tree-main">
            <span class="tree-title">${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noreferrer">${esc(item.title)}</a>` : esc(item.title)}</span>
            ${item.error ? `<div class="note bad">${esc(item.error)}</div>` : ''}
            ${item.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join('')}
          </div>
          ${badge(item.status)}
        </div>`).join('')}
      ${activeList(m)}
      ${nodeList(m)}
    </div>`;
}

async function route() {
  try {
    me = await api('/api/me');
    renderAccount();
    // A failed authorization returns here. Once signed in, the message moves to the normal place.
    const authError = location.hash.match(/error=(\w+)/)?.[1];
    if (me.role && authError) {
      draft.error = LOGIN_ERRORS[authError] ?? '';
      history.replaceState(null, '', '#/');
    }
    const hash = location.hash;
    const exportId = hash.match(/^#\/exports\/(\d+)/)?.[1];
    if (!me.role) {
      clearTimeout(pollTimer);
      showLogin();
    } else if (me.role === 'member') {
      await showMemberHome(exportId);
    } else if (hash.startsWith('#/members')) {
      await showMembers();
    } else if (hash.startsWith('#/repair')) {
      await showRepair();
    } else if (exportId) {
      await showAdminExport(exportId);
    } else {
      await showAdminHome();
    }
  } catch (err) {
    app.innerHTML = `<section class="panel"><p class="error">${esc(err.message)}</p><a href="#/">返回首页</a></section>`;
  }
}

window.addEventListener('hashchange', () => {
  draft.error = '';
  route();
});
route();
