-- E7-01 收敛：删除两张零读取方的汇总表。
--
-- rollup_sku_month(2436 行) / rollup_warehouse_sku(344 行) 夜间构建了 8 轮，
-- 但全仓库没有任何读取方（唯一被消费的是 rollup_supplier_lead，
-- 供 replenish/service.ts 的安全库存交期波动项）。
--
-- 立项理由「BI 报表实时扫全表、靠 60 秒进程内缓存硬撑」经核实不成立：
-- 那个缓存（report/auto-replenish.ts）只有读取没有赋值、从未生效，
-- 提交信息里的「15×」是同进程 call#1 与 call#2 之差；
-- 实测被怀疑慢的三支报表为 32ms / 105ms / 23ms（1026 个在售成品），
-- 不存在要解决的性能问题。
--
-- 汇总表按本层自己写明的纪律属**派生数据、可随时全量重建**，删除不丢业务真相。
-- 将来若出现真实性能证据，重新加回即可（先按 skill `measure-first` 拿基线数字）。
DROP TABLE IF EXISTS "rollup_sku_month";
DROP TABLE IF EXISTS "rollup_warehouse_sku";
