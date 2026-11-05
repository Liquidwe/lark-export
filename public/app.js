const app = document.getElementById('app');
const POLL_MS = 1500;
let pollTimer = null;
// Re-renders replace the DOM, so typed input and errors live here to survive polling.
const draft = { source: '', target: '', error: '' };
// Migrations whose full node list is open. Kept here for the same reason.
const openNodeLists = new Set();

const TYPE_LABELS = {
  docx: '文档',
  doc: '旧版文档',
  sheet: '电子表格',
  bitable: '多维表格',
  file: '文件',
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
};
const STAT_LABELS = {
  blocks: '内容块',
  images: '图片',
  files: '附件',
  boards: '画板',
  embeds: '内嵌表格',
  sheets: '工作表',
  tables: '数据表',
  fields: '字段',
  records: '记录',
  attachments: '附件',
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const isActive = (status) => status === 'running' || status === 'pausing';
const canContinue = (status) => status === 'paused' || status === 'interrupted' || status === 'failed';
const typeLabel = (type) => TYPE_LABELS[type] || type;
const badge = (status) => `<span class="badge ${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;

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
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function schedule(fn, active) {
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(fn, POLL_MS);
}

function keepInput(id, value) {
  const input = document.getElementById(id);
  if (input && document.activeElement !== input) input.value = value;
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

async function showHome() {
  const jobs = await api('/api/exports');
  renderInPlace(`
    <h1>读取文档</h1>
    <p class="sub">输入一个知识库链接，程序会把它和所有子文档读取到本地数据库。</p>
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
      showHome();
    }
  });
  schedule(route, jobs.some((job) => isActive(job.status)));
}

function jobRow(job) {
  const types = Object.entries(job.byType).map(([type, n]) => `${typeLabel(type)} ${n}`).join(' · ');
  return `
    <a class="job" href="#/exports/${job.id}">
      <div>
        <div class="job-title">${esc(job.root_title || job.source_url)}</div>
        <div class="job-meta">共 ${job.total} 个节点${types ? `：${esc(types)}` : ''}</div>
        <div class="job-meta">${new Date(job.created_at).toLocaleString('zh-CN')}</div>
      </div>
      ${badge(job.status)}
    </a>`;
}

async function showExport(id) {
  const job = await api(`/api/exports/${id}`);
  const finishedRead = (job.byStatus.done || 0) + (job.byStatus.unsupported || 0) + (job.byStatus.failed || 0);
  const migrating = job.migrations.some((m) => isActive(m.status));
  const failedCount = job.byStatus.failed || 0;
  const unread = (job.byStatus.pending || 0) + (job.byStatus.reading || 0);
  const failedNodes = job.nodes.filter((node) => node.status === 'failed');
  const totals = Object.entries(job.totals)
    .filter(([key]) => STAT_LABELS[key])
    .map(([key, value]) => `${STAT_LABELS[key]} ${value}`)
    .join(' · ');

  renderInPlace(`
    <div class="spread">
      <div>
        <h1>${esc(job.root_title || (job.status === 'running' ? '读取中…' : '未读取到文档'))}</h1>
        <p class="sub"><a href="${esc(job.source_url)}" target="_blank" rel="noreferrer">${esc(job.source_url)}</a></p>
      </div>
      ${badge(job.status)}
    </div>

    ${job.error ? `<section class="panel"><p class="error">${esc(job.error)}</p></section>` : ''}

    <div class="tiles">
      <div class="tile"><div class="tile-value">${job.total}</div><div class="tile-label">节点总数</div></div>
      ${Object.entries(job.byType).map(([type, n]) => `
        <div class="tile"><div class="tile-value">${n}</div><div class="tile-label">${esc(typeLabel(type))}</div></div>
      `).join('')}
      <div class="tile"><div class="tile-value">${formatBytes(job.assetBytes)}</div><div class="tile-label">本地文件 (${job.assetCount} 个)</div></div>
    </div>

    <section class="panel">
      <p class="facts">已读取 ${finishedRead} / ${job.total}${totals ? ` · ${esc(totals)}` : ''}</p>
      <div class="actions">
        ${job.status === 'running' ? '<button class="secondary" data-action="pause-export">暂停</button>' : ''}
        ${job.status === 'pausing' ? `<button class="secondary" disabled>暂停中…</button>
          <span class="hint-inline">${job.phase === 'tree' ? '目录读取完成后暂停' : '正在处理的文档完成后暂停'}</span>` : ''}
        ${canContinue(job.status) ? '<button data-action="resume-export">继续</button>' : ''}
        ${failedCount && !isActive(job.status) ? `<button class="secondary" data-action="retry-failed">重试全部失败的文档 (${failedCount})</button>` : ''}
      </div>
    </section>

    ${failedNodes.length ? `
      <section class="panel">
        <h2>读取失败的文档 (${failedNodes.length})</h2>
        <ul class="tree">${failedNodes.map((node) => nodeRow({ ...node, depth: 0 })).join('')}</ul>
      </section>` : ''}

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

    <section class="panel">
      <h2>文档结构</h2>
      <ul class="tree">${job.nodes.map(nodeRow).join('') || `<li class="hint">${isActive(job.status) ? '正在读取目录…' : '没有读取到节点'}</li>`}</ul>
    </section>
  `);

  document.getElementById('target-url').addEventListener('input', (e) => { draft.target = e.target.value; });
  document.getElementById('migrate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const unread = job.byStatus.failed
      ? `\n\n注意：有 ${job.byStatus.failed} 个节点读取失败，迁移后只有占位文档。建议先重试读取。`
      : '';
    try {
      const preview = await api(`/api/exports/${id}/migration-preview`, { url: draft.target });
      if (!confirm(`${describeMigration(job, preview)}${unread}\n\n确认开始迁移？`)) return;
      await api(`/api/exports/${id}/migrations`, { url: draft.target });
      draft.error = '';
    } catch (err) {
      draft.error = err.message;
    }
    route();
  });
  keepInput('target-url', draft.target);
  schedule(route, isActive(job.status) || migrating || (job.byStatus.reading || 0) > 0);
}

// Handled by delegation: polling replaces these buttons, and a click landing across
// a redraw would be lost if the listener lived on the button itself.
const ACTIONS = {
  'pause-export': ({ exportId }) => api(`/api/exports/${exportId}/pause`, {}),
  'resume-export': ({ exportId }) => api(`/api/exports/${exportId}/resume`, {}),
  'retry-failed': ({ exportId }) => api(`/api/exports/${exportId}/resume`, { retryFailed: true }),
  'retry-node': ({ exportId, target }) => api(`/api/exports/${exportId}/nodes/${target}/retry`, {}),
  'pause-migration': ({ target }) => api(`/api/migrations/${target}/pause`, {}),
  'resume-migration': ({ target }) => api(`/api/migrations/${target}/resume`, {}),
  'toggle-nodes': ({ target }) => {
    if (!openNodeLists.delete(target)) openNodeLists.add(target);
  },
};

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const exportId = location.hash.match(/^#\/exports\/(\d+)/)?.[1];
  try {
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
  return lines.join('\n');
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
  return `
    <div class="migration">
      <div class="spread">
        <div class="job-meta">迁移 #${m.id} → <a href="${esc(m.target_url)}" target="_blank" rel="noreferrer">${esc(m.target_url)}</a></div>
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
  const match = location.hash.match(/^#\/exports\/(\d+)/);
  try {
    if (match) await showExport(match[1]);
    else await showHome();
  } catch (err) {
    app.innerHTML = `<section class="panel"><p class="error">${esc(err.message)}</p></section>`;
  }
}

window.addEventListener('hashchange', () => {
  draft.error = '';
  route();
});
route();
