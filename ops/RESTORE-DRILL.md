# 恢复演练（每季一次，RTO≤4h——01 §8）
1. 新机器: 安装 docker; git clone; 复制 .env.prod。
2. `docker compose -f docker-compose.prod.yml up -d db` 等健康。
3. `gunzip -c db_<最近>.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U scm scm`
4. 附件: `docker run --rm -v supply-chain_uploads:/data -v $PWD:/backup alpine tar xzf /backup/uploads_<最近>.tar.gz -C /data`
5. `ops/deploy.sh`（跳过迁移亦可——备份已含 schema）。
6. 验收: /api/health ok:true; 登录; 抽查 3 张单据与流水一致; 记录耗时于本文件底部演练日志。

## 备份调度与新鲜度监控
- 调度: `ops/deploy.sh` 的 install-backup-schedule 步骤自动安装 systemd 单元
  `scm-backup.timer` + `scm-backup.service`（每日 02:30 Asia/Shanghai，`Persistent=true`
  停机补跑；源文件 `ops/backup.timer` / `ops/backup.service`，`__REPO_DIR__` 安装时替换）。
  无 systemd 的主机按 `ops/crontab.example` 装 cron（二选一，勿双装）。
- 环境: 备份目的地经 `.env.backup`（`BACKUP_DIR` / `BACKUP_REMOTE`）注入 service；
  `BACKUP_REMOTE` 必须配置出主机目的地（01 §8）。
- 新鲜度: `ops/check-backup.sh` —— 最新 `db_*.sql.gz` 超 25h（给 02:30 调度留 1h 余量）
  即非零退出（1=过期，2=无备份），接 cron 邮件或外部监控探针，每小时跑一次。
- 手动验证: `systemctl list-timers scm-backup.timer` 看下次触发；
  `systemctl start scm-backup.service` 即时试跑一轮备份。

## 演练日志
| 日期 | 执行人 | 耗时 | 结果 |
|---|---|---|---|
| （占位——待恢复演练执行后由执行人填写；由编排方运行演练） | | | |

| 2026-07-24 | dev/PGlite | scripts/restore-drill-dev.ts | ✅ 备份261ms/校验171ms；skus 5376·ledger 348·snapshots 1731·transit 8305·review 1769 全对 | Claude（会话内） |
