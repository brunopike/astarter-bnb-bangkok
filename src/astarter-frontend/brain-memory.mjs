import {ROLES, GROUPS} from './simulation.mjs';
import {RESEARCH_GROUPS} from './multi-research.mjs';
import {translate} from './locale.mjs';
import {uiGlyph} from './product-composition.mjs';
import {escapeUI} from './product-experience.mjs';
import caseData from './brain-merge-case.json' with {type:'json'};

// The case records have no role or subagent receipts. These are editorial mappings
// from an archived artifact to an existing team responsibility, never activity logs.
const caseRoles = {
  A01: {
    ref: caseData.snapshotRef,
    task: ['合并时点的市场背景是什么？','What was the market context at the Merge?'],
    child: ['对齐主网区块和 Coinbase 分钟线的时间。','Align the mainnet block and the Coinbase candle timestamps.'],
    finding: ['首个 PoS 执行区块在 06:42:59 UTC 产生，快照截止于 06:44 UTC。','The first PoS execution block arrived at 06:42:59 UTC. The snapshot cutoff was 06:44 UTC.'],
    merge: ['同一快照保留两份独立原始记录。','The snapshot retains both independent source records.']
  },
  A03: {
    ref: 'ETH-MERGE-MARKET@1',
    task: ['合并前后的价格结构有何变化？','How did prices change around the Merge?'],
    child: ['按时间排列 Coinbase 的两根已收盘分钟线。','Order the two closed Coinbase minute candles by time.'],
    finding: ['ETH-USD 从 $1,589.44 升至 $1,616.76，仅覆盖 Coinbase。','ETH-USD rose from $1,589.44 to $1,616.76 on Coinbase.'],
    merge: ['市场判断保留单场所限制及盘口深度缺口。','The finding retains its single-venue scope and the missing depth data.']
  },
  A13: {
    ref: caseData.strategyRef,
    task: ['现有证据支持发布哪种策略？','Which strategy does the evidence support?'],
    child: ['将链上判断和单场所价格变化逐项对照。','Compare the chain finding with the single-venue price move.'],
    finding: ['策略 v1 进入观察，待独立场所成交和可执行深度补齐。','Strategy v1 stays on watch pending independent trades and executable depth.'],
    merge: ['观察条件、失效时间和依据绑定在同一版策略。','Watch conditions, expiry and findings stay with the same strategy version.']
  },
  A18: {
    ref: 'ETH-MERGE-REVIEW@1',
    task: ['到期时，市场与两条交易路径各有什么结果？','What happened in the market and on each execution route at expiry?'],
    child: ['按策略版本对齐到期行情与两条路径的订单状态。','Match expiry candles and the two order states to the strategy version.'],
    finding: ['Coinbase 五分钟上涨 +' + caseData.outcome.marketObservation.changePct + '%。用户成交未知，AI 交易无订单。','Coinbase rose ' + caseData.outcome.marketObservation.changePct + '% in five minutes. User fills are unknown. LensWave had no order.'],
    merge: ['行情变化与实际成交分别归入策略 v1。','The market move and execution results are filed separately against strategy v1.']
  }
};

const byRef = new Map(caseData.nodes.map(node => [node.ref, node]));
const evidence = {
  'BLOCK-15537394@1': {key:'block', title:['主网区块 15,537,394','Mainnet block 15,537,394']},
  'COINBASE-ETH-USD-0644@1': {key:'candles', title:['Coinbase · 快照分钟线','Coinbase · snapshot candles']},
  'COINBASE-ETH-USD-0649@1': {key:'review', title:['Coinbase · 到期分钟线','Coinbase · expiry candles']}
};

function linkedEvidence(ref) {
  const node = byRef.get(ref);
  if (!node) return [];
  if (node.evidenceRefs.length) return node.evidenceRefs;
  // A strategy's sources sit on its two cited findings, not on the strategy itself.
  return [...new Set(caseData.edges.filter(edge => edge.from === ref && edge.type === 'based_on')
    .flatMap(edge => byRef.get(edge.to)?.evidenceRefs || []))];
}

// Reading shortcuts into the current graph are independent of task receipts.
const roleTopics = {
  A01:[2,10], A02:[2,7], A03:[2,6], A04:[2,13], A05:[8,7], A06:[2,15],
  A07:[3,10], A08:[3,14], A09:[3,15], A10:[10,15], A11:[3,10], A12:[3,13],
  A13:[3,10], A14:[8,15], A15:[3,15], A16:[8,12], A17:[7,12], A18:[11,12,13]
};
// Role briefs describe the questions a member owns. Only attached records can
// tell us whether that member did any work on the selected snapshot.
const roleBriefs = {
  A01:['对照行情覆盖、交易场所和采集时点，界定这份快照能解释哪一段市场。','Establish which market and time window the snapshot covers before interpreting a move.'],
  A02:['把短线波动放回较长周期，核对各周期的收盘时间和趋势分歧。','Align closing times across intervals and identify where short- and long-term trends diverge.'],
  A03:['沿时间轴核对高低点、收盘价与突破位置，保留价格形态失效的条件。','Read highs, lows and closes in order. Keep the price level that would invalidate a breakout.'],
  A04:['对齐成交量与价格变化的时间窗，区分全市场成交和单个池子的放量。','Match volume to the price window and distinguish market-wide turnover from activity in one pool.'],
  A05:['从报价场所、盘口深度与价差判断一笔订单能成交多少，以及可能付出的滑点。','Use venue depth and spreads to assess fillable size and the slippage an order could incur.'],
  A06:['定位波动跳变的起止时点，检查异常是否只出现在单一场所。','Locate when a volatility spike began and ended, then check whether it was confined to one venue.'],
  A07:['逐条核对策略触发条件、证据来源和有效期，记录哪一条规则仍缺依据。','Match each trigger to its source and expiry, and identify rules that still lack evidence.'],
  A08:['核对入场假设需要的价格、流动性与独立证据，写明什么变化会推翻它。','Check the price, liquidity and independent evidence behind an entry thesis and define its invalidation.'],
  A09:['定位退出假设依赖的价位与深度，复查减仓时可能遇到的成本和反证。','Identify the price and depth an exit depends on, including its costs and counterevidence.'],
  A10:['从原始来源检查相互矛盾的观察，区分独立证据与同一消息的重复转述。','Trace conflicting observations to their originals and identify reports that repeat a single source.'],
  A11:['列出尚缺的确认条件、下一次核验时点，以及继续等待的理由。','Record the missing confirmation, the next point to check and the reason to wait.'],
  A12:['为延续、反转与失效三种情景分别记录触发点，保留路径切换的条件。','Define triggers for continuation, reversal and invalidation, including when to switch scenarios.'],
  A13:['把一致结论、反证和待核问题归入同一版判断，让下一位成员能回查每个依据。','Bring findings, objections and open questions into one decision with traceable references.'],
  A14:['按资产、网络与方向检查敞口重叠，识别多笔头寸共同承担的风险。','Check overlaps by asset, network and direction to find risks shared across positions.'],
  A15:['核对不利情景下的损失范围、退出流动性和保护条件，标出仍未知的敞口。','Review downside, exit liquidity and protection conditions, and flag exposure that remains unknown.'],
  A16:['把订单时间与可成交报价对齐，用实际回执核对成交价、滑点、费用和拒单原因。','Align orders with executable quotes and use receipts to check fills, slippage, fees and rejections.'],
  A17:['沿采集和订单时间查找断点，核对是数据延迟、采集缺口，还是执行环节异常。','Trace gaps along the capture and order timeline to distinguish feed delays, missing data and execution faults.'],
  A18:['将策略发布时的判断、后续行情与实际回执分开归档，留下下次可复查的依据。','File the original thesis, subsequent market movement and actual receipts separately for the next review.']
};
const selectedByScope = new Map();

const teamIcons = {chart:'chart', nodes:'layers', pulse:'pulse', bars:'columns', diamond:'shield', calendar:'clock'};
const groupIceShare = group => 100 * (1 - RESEARCH_GROUPS.indexOf(group) / Math.max(1, RESEARCH_GROUPS.length - 1)) + '%';

function mountMemory(host, {en = false, pinnedFile, files = {}, onBack, researchScope, getNodes, onOpenNode} = {}) {
  const t = (zh, english) => en ? english : zh;
  const say = value => Array.isArray(value) ? value[en ? 1 : 0] : value;
  const name = value => en ? translate(value, 'en') : value;
  const scopeKey = researchScope && (researchScope.id ?? JSON.stringify(researchScope.label));
  const scopeName = say(researchScope?.label) || t('当前资产','Current asset');
  const root = document.createElement('section');
  root.className = 'memory-workbench';
  const stellar=Boolean(host.closest('astarter-brain[data-view=cortexa]'));
  root.toggleAttribute('data-stellar',stellar);
  root.setAttribute('aria-label', t('Agent 记忆', 'Agent memory'));
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = '/brain-memory.css';
  root.append(style);
  const body = document.createElement('div');
  root.append(body);
  host.replaceChildren(root);
  const mappingCount = ROLES.filter(role => caseRoles[role.id]).length;
  body.innerHTML = `
    <header class="mw-head"><h2>${t('Agent 记忆','Agent memory')}</h2>
      <button type="button" class="mw-back">${uiGlyph('back')}${t('返回图谱','Back to graph')}</button></header>
    <div class="mw-workspace">
      <section class="mw-roster" aria-label="${t('战队成员','Team members')}">
        <header class="mw-toolbar"><h3>${t('战队成员','Team members')}</h3><span>${researchScope ? escapeUI(scopeName) : `<i class="mw-record-dot"></i>${t('案例映射','Case mapping')} ${mappingCount}`}</span></header>
        <div class="mw-teams">${RESEARCH_GROUPS.map(group => `<section class="mw-team" style="--mw-team:${group.color};--mw-ice-share:${groupIceShare(group)}" aria-label="${escapeUI(name(group.label))}">
          <h4>${stellar ? uiGlyph(teamIcons[group.glyph]) : '<i></i>'}<span>${escapeUI(name(group.label))}</span></h4>
          <div class="mw-seats">${group.roles.map(index => {
            const role = ROLES[index];
            return `<button type="button" class="mw-seat" data-agent="${role.index}" data-role-id="${role.id}" aria-pressed="false">
              <span class="mw-seat-id">${role.id}${(researchScope ? researchScope.members?.[role.id]?.rows?.length : caseRoles[role.id]) ? '<i class="mw-record-dot"></i>' : ''}</span><span class="mw-seat-name">${escapeUI(name(role.name))}</span></button>`;
          }).join('')}</div></section>`).join('')}</div>
      </section>
      <article class="mw-inspector" tabindex="-1" aria-label="${t('成员工作记忆','Member working memory')}"></article>
    </div>`;
  const inspector = body.querySelector('.mw-inspector');
  const buttons = [...body.querySelectorAll('[data-role-id]')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const stacked = matchMedia('(max-width: 880px)');
  let activeId;
  const requests = new Set();

  function cancelReads() {
    for (const controller of requests) controller.abort();
    requests.clear();
  }

  function jump(el) {
    const immediate=reduced.matches || document.documentElement.dataset.reducedMotion==='true';
    el.scrollIntoView({behavior:immediate ? 'instant' : 'smooth', block:'start'});
    el.focus({preventScroll:true});
  }

  function sourceDisclosure(ref) {
    const source = evidence[ref];
    if (!source) return '';
    return `<details class="mw-evidence" data-evidence="${ref}"><summary><span>${uiGlyph('file')}${escapeUI(say(source.title))}</span>${uiGlyph('chevron')}</summary><div class="mw-record"></div></details>`;
  }

  function rowValue(row) {
    const value=String(say(row.value));
    const networks=stellar && row.label?.[0]==='网络'?value.split(' · '):[];
    if(networks.length<5)return escapeUI(value);
    return `<details class="mw-networks"><summary>${escapeUI(networks.slice(0,2).join(' · '))}<span>+${networks.length-2}</span></summary><p>${escapeUI(networks.slice(2).join(' · '))}</p></details>`;
  }
  function renderRows(rows) {
    return `<dl class="mw-transfer">${rows.map(row =>
      `<div><dt>${escapeUI(say(row.label))}</dt><dd>${rowValue(row)}</dd></div>`).join('')}</dl>`;
  }
  function relatedNodes(id) {
    const nodes=getNodes?.() ?? [];
    return (roleTopics[id] ?? []).filter(index => nodes[index]).map(index => {
      const node=nodes[index];
      return {index,title:say(node.title),body:say(node.body),source:node.sourceUrl};
    });
  }
  function topicLinks(id) {
    if(!onOpenNode)return '';
    const links=relatedNodes(id).map(({index,title,body})=>
      `<button type="button" class="mw-note-link" data-mw-node="${index}"><span><strong>${escapeUI(title)}</strong><span class="mw-note-excerpt">${escapeUI(body)}</span></span>${uiGlyph('arrow')}</button>`);
    return links.length?`<section class="mw-notes"><h4>${t('关联记忆','Related memory')}</h4><div class="mw-note-list">${links.join('')}</div></section>`:'';
  }
  function memoryRecord(id) {
    const role=ROLES.find(item=>item.id===id);
    const group=RESEARCH_GROUPS.find(item=>item.roles.includes(role.index));
    const member={id,role:name(role.name),team:name(group.label)};
    if(researchScope){
      const fields=rows=>(rows ?? []).map(row=>({field:say(row.label),value:say(row.value)}));
      const personal=researchScope.members?.[id]?.rows;
      return {member,scope:researchScope.id ?? scopeName,
        member_memory:personal?.length ? fields(personal) : null,
        shared_snapshot:fields(researchScope.rows),
        related_nodes:relatedNodes(id)};
    }
    const assignment=caseRoles[id];
    const record=assignment ? byRef.get(assignment.ref) : null;
    return {member,scope:caseData.caseId,member_memory:null,
      shared_snapshot:{ref:caseData.snapshotRef,cutoff:caseData.decisionCutoff},
      case_mapping:record ? {
        ref:record.ref,body_sha256:record.bodySha256,task:say(assignment.task),
        subtask:say(assignment.child),finding:say(assignment.finding),
        merge:say(assignment.merge),evidence_refs:linkedEvidence(record.ref)
      } : null};
  }
  function paintCode() {
    const disclosure=inspector.querySelector('.mw-code');
    if(!disclosure?.open)return;
    const code=disclosure.querySelector('code');
    const json=JSON.stringify(memoryRecord(activeId),null,2);
    if(code.textContent===json)return;
    const fragment=document.createDocumentFragment();
    const token=/"(?:\\.|[^"\\])*"|\b(?:true|false|null|-?\d+(?:\.\d+)?)\b/g;
    let end=0;
    for(const match of json.matchAll(token)){
      fragment.append(json.slice(end,match.index));
      end=match.index+match[0].length;
      const span=document.createElement('span');
      span.className=json[end]===':'?'mw-json-key':match[0][0]==='"'?'mw-json-value':'mw-json-literal';
      span.textContent=match[0];
      fragment.append(span);
    }
    fragment.append(json.slice(end));
    code.replaceChildren(fragment);
  }
  function codeDisclosure() {
    return `<details class="mw-code"><summary><span class="mw-code-braces" aria-hidden="true">{ }</span><strong>${t('记忆代码','Memory code')}</strong><span class="mw-code-format">JSON</span>${uiGlyph('chevron')}</summary><pre tabindex="0" role="region" aria-label="${t('当前成员记忆 JSON','Selected member memory JSON')}"><code></code></pre></details>`;
  }
  function scopedMemory(id) {
    const personal=researchScope.members?.[id]?.rows ?? [];
    const shared=researchScope.rows ?? [];
    if(stellar)return `
      ${personal.length?`<div class="mw-case-heading"><h4>${t('成员工作记忆','Member working memory')}</h4></div>${renderRows(personal)}`:''}
      ${topicLinks(id)}
      <details class="mw-sources mw-snapshot"><summary><span>${uiGlyph('layers')}${t('共享快照','Shared snapshot')}</span><span>${escapeUI(scopeName)}${uiGlyph('chevron')}</span></summary>
        ${shared.length?renderRows(shared):`<p class="mw-empty">${t('暂无公开快照。','No public snapshot available.')}</p>`}
      </details>`;
    return `<div class="mw-case-heading"><h4>${t('成员记忆','Member memory')}</h4></div>
      ${personal.length ? renderRows(personal) : `<p class="mw-empty">${t('暂无独立任务或回执。','No individual tasks or receipts recorded.')}</p>`}
      <section class="mw-sources"><header><h4>${t('可引用的公开快照','Shared public snapshot')}</h4><code>${escapeUI(scopeName)}</code></header>
        ${shared.length ? renderRows(shared) : `<p class="mw-empty">${t('暂无公开快照。','No public snapshot available.')}</p>`}
      </section>`;
  }

  function selectRole(id, focus = false) {
    const role = ROLES.find(item => item.id === id);
    if (!role) return;
    const team = RESEARCH_GROUPS.find(group => group.roles.includes(role.index));
    const assignment = caseRoles[role.id];
    activeId = id;
    if(researchScope) selectedByScope.set(scopeKey,id);
    cancelReads();
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.roleId === id));
    inspector.style.setProperty('--mw-team', team.color);
    inspector.style.setProperty('--mw-ice-share',groupIceShare(team));
    inspector.dataset.activeRole = id;
    const codeWasOpen=inspector.querySelector('.mw-code')?.open;
    const snapshotWasOpen=inspector.querySelector('.mw-snapshot')?.open;
    inspector.innerHTML = `
      <header class="mw-profile">
        ${stellar?`<span class="mw-call-sign">${id}</span><div><span class="mw-membership">${escapeUI(name(team.label))} / ${escapeUI(name(GROUPS[role.group].label))}</span><h3>${escapeUI(name(role.name))}</h3><p>${escapeUI(say(roleBriefs[id]))}</p></div>`:`<div class="mw-profile-line"><span class="mw-id">${id}</span><span class="mw-membership">${escapeUI(name(team.label))} / ${escapeUI(name(GROUPS[role.group].label))}</span></div>
        <h3>${escapeUI(name(role.name))}</h3><p>${escapeUI(name(role.description))}</p>`}
      </header>
      ${researchScope ? scopedMemory(id) : `<div class="mw-case-heading"><h4>${t('工作记忆','Working memory')}</h4><span>${assignment ? t('历史案例映射','Historical case mapping') : t('本案例未分配','Unassigned in this case')}</span></div>
      ${assignment ? `<dl class="mw-transfer">
        ${[[t('大脑下行','Brain assignment'),assignment.task],[t('子任务','Subtask'),assignment.child],
          [t('上行发现','Reported finding'),assignment.finding],[t('记忆归并','Memory merge'),assignment.merge]]
          .map(([label,value]) => `<div><dt>${label}</dt><dd>${escapeUI(say(value))}</dd></div>`).join('')}
        </dl><section class="mw-sources"><header><h4>${t('同版证据','Versioned evidence')}</h4><code>${escapeUI(assignment.ref)}</code></header>
        ${linkedEvidence(assignment.ref).map(sourceDisclosure).join('')}</section>`
      : `<p class="mw-empty">${t('以太坊合并案例未收录这个岗位的子任务、证据或记忆交接。','The Ethereum Merge case contains no subtask, evidence or memory handoff for this member.')}</p>`}`}
      ${codeDisclosure()}
      <button type="button" class="mw-members-back">${uiGlyph('back')}${t('返回成员','Back to members')}</button>`;
    const disclosure=inspector.querySelector('.mw-code');
    disclosure.addEventListener('toggle',paintCode);
    if(codeWasOpen){disclosure.open=true;paintCode();}
    const snapshot=inspector.querySelector('.mw-snapshot');
    if(snapshotWasOpen && snapshot)snapshot.open=true;
    for (const detail of inspector.querySelectorAll('.mw-evidence')) {
      detail.addEventListener('toggle', () => { if (detail.open) readEvidence(detail); });
    }
    if (focus && stacked.matches) jump(inspector);
    return inspector;
  }

  async function readEvidence(detail) {
    const output = detail.querySelector('.mw-record');
    if (output.dataset.loaded === 'true' || output.dataset.loading === 'true') return;
    const {key} = evidence[detail.dataset.evidence];
    const controller = new AbortController();
    requests.add(controller);
    output.dataset.loading = 'true';
    output.textContent = t('读取中…', 'Loading…');
    try {
      const response = await fetch(pinnedFile(key), {signal:controller.signal});
      if (!response.ok) throw new Error('Evidence unavailable');
      const raw = await response.json();
      if (controller.signal.aborted || !detail.isConnected) return;
      const rows = key === 'block'
        ? [[t('区块','Block'),Number(raw.height).toLocaleString('en-US')],[t('时间','Time'),raw.timestamp],
          [t('交易笔数','Transactions'),raw.transactions_count],[t('哈希','Hash'),raw.hash]]
        : [...raw].sort((a,b) => a[0] - b[0]).map(candle => [
          new Date(candle[0]*1000).toISOString().slice(11,16) + ' UTC',
          t('收盘','Close') + ' ' + Number(candle[4]).toLocaleString('en-US',{style:'currency',currency:'USD'})]);
      output.innerHTML = `<dl>${rows.map(([label,value]) => `<div><dt>${escapeUI(label)}</dt><dd>${escapeUI(value)}</dd></div>`).join('')}</dl>`;
      if (files[key]) {
        const link = document.createElement('a');
        link.href = files[key];
        link.rel = 'noreferrer';
        link.target = '_blank';
        link.textContent = t('数据来源 ↗','Data source ↗');
        output.append(link);
      }
      output.dataset.loaded = 'true';
    } catch {
      if (!controller.signal.aborted) output.textContent = t('证据暂不可读，重新展开可重试。','Evidence unavailable. Reopen to retry.');
    } finally {
      requests.delete(controller);
      delete output.dataset.loading;
    }
  }

  function click(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.roleId) selectRole(button.dataset.roleId, true);
    else if(button.hasAttribute('data-mw-node'))onOpenNode?.(Number(button.dataset.mwNode));
    else if (button.classList.contains('mw-members-back')) jump(buttons.find(item => item.dataset.roleId === activeId));
    else if (button.classList.contains('mw-back')) onBack?.();
  }
  const selectReview = () => selectRole('A18');
  function select(index) {
    // The replay bridge uses 0 for the snapshot, 1 for market and 2 for review.
    return selectRole(typeof index === 'string' ? index : ['A01','A03','A18'][index]);
  }
  body.addEventListener('click', click);
  selectRole((researchScope && selectedByScope.get(scopeKey)) || 'A01');
  function refreshSnapshot(next){
    if(!next || !researchScope || next.id!==scopeKey || say(next.label)!==scopeName || next.members!==researchScope.members)return false;
    const rows=next.rows??[],cells=inspector.querySelectorAll('.mw-sources .mw-transfer>div');
    if(rows.length!==cells.length)return false;
    const previousRows=researchScope.rows??[];
    researchScope=next;
    rows.forEach((row,i)=>{
      const term=cells[i].firstElementChild,detail=cells[i].lastElementChild;
      const {label,value}=row;
      if(term.textContent!==say(label))term.textContent=say(label);
      if(say(previousRows[i]?.value)!==say(value) || say(previousRows[i]?.label)!==say(label)){
        const expanded=detail.querySelector('details')?.open;
        detail.innerHTML=rowValue(row);
        if(expanded && detail.firstElementChild?.matches('details'))detail.firstElementChild.open=true;
      }
    });
    const nodes=getNodes?.() ?? [];
    for(const button of inspector.querySelectorAll('[data-mw-node]')){
      const node=nodes[Number(button.dataset.mwNode)];
      if(!node)continue;
      const title=button.querySelector('strong'),excerpt=button.querySelector('.mw-note-excerpt');
      if(title.textContent!==say(node.title))title.textContent=say(node.title);
      if(excerpt.textContent!==say(node.body))excerpt.textContent=say(node.body);
    }
    paintCode();
    return true;
  }
  return {select, selectRole, selectReview, refreshSnapshot, dispose() {
    body.removeEventListener('click',click);
    cancelReads();
    root.remove();
  }};
}

export {mountMemory};
