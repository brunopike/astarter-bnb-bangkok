export const GROUPS = {
  market: { label: '市场观察', color: '#6147fa' },
  research: { label: '策略研究', color: '#83276f' },
  risk: { label: '决策与风险', color: '#a05309' },
  review: { label: '运行复盘', color: '#107647' },
};

const names = ['市场环境','多周期趋势','价格行为与形态','成交量与量价','盘口与流动性','波动与异常','策略规则映射','做多论证','减仓与卖出论证','反证质询','等待与不交易','情景路径','决策整合','组合与敞口','资本保护审阅','执行质量评估','运行异常诊断','交易归因与复盘'];
const descriptions = ['辨认市场环境，整理可用证据。','交叉检查不同周期的方向。','核对价格结构与关键形态。','检查成交量与价格的配合。','核对盘口深度、价差与数据时效。','检查波动跳变与异常条件。','把研究证据映射到既定规则。','独立整理支持入场的条件。','检查减持、退出与反向证据。','检查推论中的矛盾和证据缺口。','检查等待条件与不交易理由。','推演 A / B / C 条件和应对路径。','汇总本轮结论与未解决分歧。','审阅组合集中度与敞口影响。','审阅不利情景与资本保护条件。','审阅时效、价差与执行条件。','解释运行异常及其影响范围。','记录本轮归因与可复用经验。'];
export const ROLES = names.map((name, i) => ({ index: i, id: `A${String(i + 1).padStart(2, '0')}`, name, description: descriptions[i], group: i < 6 ? 'market' : i < 12 ? 'research' : i < 16 ? 'risk' : 'review' }));
export const SCENARIOS = {
  liquidity: { name: '盘口变化 · 联合核验', actors: [0,4,5,15,12], outputs: ['示例盘口数据已载入。','深度变化已核对，继续检查价差。','异常条件核验完成，未触发升级。','执行条件已复核，等待整合。','本轮证据已汇总，结论为继续观察。'] },
  volatility: { name: '波动异常 · 风险审阅', actors: [0,1,5,9,11,14,12], outputs: ['合成市场环境已标记为波动升高。','多周期条件存在分歧，已记录。','跳变条件命中，发起针对性审阅。','反证已补充，关键分歧继续保留。','A / B / C 预案已分别列出。','保护条件已复核，建议暂停新增风险。','本轮风险意见已归并。'] },
  review: { name: '策略复核 · 情景推演', actors: [6,9,11,12], outputs: ['策略条件已逐项映射。','一项证据缺口已标记。','A / B / C 条件推演完成。','方案已汇总，等待补充证据。'] },
};
export const PHASES = ['观察与核验', '证据交接', '结论整合', '记录与回流'];
export const CYCLE_DURATION = 24;

export class Simulation {
  constructor(key = 'liquidity') { this.reset(key); }
  reset(key = this.key, maxCycles = 0) {
    if (!SCENARIOS[key]) throw new Error('Unknown simulation scenario');
    this.epoch = (this.epoch || 0) + 1;this.runId=globalThis.crypto.randomUUID();
    this.key = key; this.elapsed = 0; this.cycle = 0; this.handoffs = 0; this.events = []; this.sequence = 0;
    this.holdUntil = 0;this.disposition=null;this.additionalActors=[];
    this.maxCycles = [0,1,3].includes(maxCycles) ? maxCycles : 0; this.completed = false;
    this.record(0, null, SCENARIOS[key].actors[0], '新的演示数据已载入');
    this.nextEvent = 0;
  }
  get config() {const base=SCENARIOS[this.key];return this.additionalActors.length?{...base,actors:[...base.actors.filter(id=>id!==12),...this.additionalActors,12],outputs:[...base.outputs.slice(0,-1),...this.additionalActors.map(()=> '补充核验任务'),base.outputs.at(-1)]}:base;}
  get position() { return this.completed ? CYCLE_DURATION : Math.min(CYCLE_DURATION,this.elapsed-this.cycle*CYCLE_DURATION); }
  get phase() { return Math.min(3, Math.floor(this.position / 6)); }
  get progress() { return this.position / CYCLE_DURATION; }
  get observation() {
    const p=this.position, phase=Math.min(3,Math.floor(p/6));
    const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
    const phases=['观察中','线索出现','交叉核验','本轮记录'];
    const notes={
      liquidity:[['留意盘口的变化','背景活动持续更新，尚未形成观察线索。'],['深度开始回补','价差与盘口变化指向同一区域，继续核对。'],['核对异常与执行条件','等待各项核验结果。'],['继续观察','线索已记下，仍需等待后续变化。']],
      volatility:[['留意波动的变化','观察各周期是否出现相同变化。'],['出现方向分歧','局部波动放大，暂不据此判断机会。'],['核对不利条件','反向证据仍在，保护条件优先。'],['暂不跟进','分歧没有消除，本轮不保留机会线索。']],
      review:[['核对策略条件','先检查条件是否齐备。'],['发现一处缺口','部分条件能够对应，证据尚不完整。'],['等待补充证据','情景推演继续，保留未解决的问题。'],['留待复核','证据缺口仍在，补充后再看。']],
    };
    const [title,detail]=notes[this.key][phase];
    let strength=smooth(3,17,p);
    if(this.key==='volatility')strength*=1-smooth(17,22,p)*.88;
    if(this.key==='review')strength*=.64;
    return {phase,label:phases[phase],title,detail,strength,result:phase<3?'pending':this.key==='liquidity'?'watch':this.key==='volatility'?'pass':'incomplete'};
  }
  record(at, from, to, text) {
    this.events.unshift({ id: `${this.epoch}:${++this.sequence}`, at, from, to, text });
    this.events.length = Math.min(24, this.events.length);
    if (from !== null) this.handoffs++;
  }
  advance(dt) {
    if (this.completed || !Number.isFinite(dt) || dt < 0) return;
    const target = this.elapsed + Math.min(dt, CYCLE_DURATION * 2);
    while (this.elapsed < target) {
      const boundary = Math.max((this.cycle + 1) * CYCLE_DURATION, this.maxCycles===1?this.holdUntil:0);
      const actors = SCENARIOS[this.key].actors;
      const at = this.cycle * CYCLE_DURATION + 1.2 + this.nextEvent * (20 / actors.length);
      if (this.nextEvent < actors.length && at <= target && at < boundary) {
        this.elapsed = at;
        const index = this.nextEvent;
        const from = actors[index];
        const to = actors[(index + 1) % actors.length];
        this.record(at, from, to, index === actors.length - 1 ? '结论归档，信息回流至观察角色' : this.config.outputs[index]);
        this.nextEvent++;
      } else if (boundary <= target) {
        if (this.maxCycles > 0 && this.cycle + 1 >= this.maxCycles) {
          this.elapsed = boundary; this.completed = true;
          this.record(boundary, null, actors.at(-1), '已完成配置轮数，演示已结束');
          return;
        }
        this.elapsed = boundary; this.cycle++; this.nextEvent = 0;
        this.record(boundary, null, actors[0], '下一轮观察开始');
      } else { this.elapsed = target; }
    }
  }
  inject(kind) {
    if (this.completed || !['market','volatility','risk'].includes(kind)) return false;
    const actors = this.config.actors;
    const from = kind === 'market' ? actors[0] : kind === 'volatility' ? actors[Math.min(2,actors.length-2)] : actors.at(-2);
    const to = kind === 'market' ? actors[1] : actors.at(-1);
    const names = {market:'行情信号',volatility:'波动异常',risk:'风险事件'};
    this.record(this.elapsed, from, to, `手动注入：${names[kind]}，加入示例记录`);
    return true;
  }
  status(index) {
    const offset = this.config.actors.indexOf(index);
    if (offset === -1) return 'idle';
    const start = Math.max(0, offset * 20 / this.config.actors.length - 1.4);
    const end = 1.2 + offset * 20 / this.config.actors.length;
    if (this.position < start) return 'queued';
    if (this.position < end) return 'running';
    return 'done';
  }
  output(index) {
    const offset = this.config.actors.indexOf(index);
    if (offset === -1) return '本轮未调用此角色。';
    const status = this.status(index);
    if (status === 'queued') return '等待本轮证据交接。';
    if (status === 'running') return '正在处理合成证据，等待本次输出。';
    return this.config.outputs[offset];
  }
  get flows() { return this.events.filter(e => e.from !== null && this.elapsed - e.at < 6.8); }
}
