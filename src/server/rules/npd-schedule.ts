/**
 * NPD 1.x 计划排程（纯函数）：以 69 节点标准（transit_refs kind=npd_node）为模板，
 * 沿「上一节点」链拓扑推算自然日计划（planStart/planEnd）。
 *
 * 口径：
 * - 起点节点（无上一节点或链外引用）planStart = 项目启动日；
 * - 后继节点 planStart = 上一节点 planEnd（同日交接，串行链；模板未表达并行分支合流，
 *   多前驱场景以链上唯一「上一节点」为准——与业务模拟表同假设）；
 * - planEnd = planStart + max(days,0) 自然日（模板天数为空按 0=里程碑）；
 * - 环/断链兜底：无法拓扑的余量按模板顺序追加在最晚 planEnd 之后（诚实降级，不丢节点）。
 */

export interface NpdTemplateNode {
  nodeNo: string | null;
  name: string;
  stage: string | null;
  dept: string | null;
  days: number;
  prev: string | null; // 上一节点名称
}

export interface ScheduledTask {
  seq: number;
  nodeNo: string | null;
  name: string;
  stage: string | null;
  dept: string | null;
  days: number;
  planStart: string;
  planEnd: string;
}

const DAY_MS = 86_400_000;

function addDays(ymd: string, days: number): string {
  const t = Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

export function scheduleNpd(nodes: NpdTemplateNode[], startDate: string): ScheduledTask[] {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const done = new Map<string, { planStart: string; planEnd: string }>();
  const out: ScheduledTask[] = [];
  let seq = 0;

  const emit = (n: NpdTemplateNode, planStart: string) => {
    const days = Math.max(0, Math.floor(n.days || 0));
    const planEnd = addDays(planStart, days);
    done.set(n.name, { planStart, planEnd });
    out.push({ seq: ++seq, nodeNo: n.nodeNo, name: n.name, stage: n.stage, dept: n.dept, days, planStart, planEnd });
  };

  /* Kahn：每轮取「前驱已排或前驱不在模板内」的未排节点，按模板原序稳定 */
  let remaining = nodes.slice();
  for (;;) {
    const ready = remaining.filter((n) => !n.prev || !byName.has(n.prev) || done.has(n.prev));
    if (ready.length === 0) break;
    for (const n of ready) {
      const prevEnd = n.prev ? done.get(n.prev)?.planEnd : undefined;
      emit(n, prevEnd ?? startDate);
    }
    const readySet = new Set(ready.map((n) => n.name));
    remaining = remaining.filter((n) => !readySet.has(n.name));
  }

  /* 环兜底：余量按模板顺序接在最晚 planEnd 之后 */
  if (remaining.length > 0) {
    let cursor = out.reduce((m, t) => (t.planEnd > m ? t.planEnd : m), startDate);
    for (const n of remaining) {
      emit(n, cursor);
      cursor = done.get(n.name)!.planEnd;
    }
  }
  return out;
}
