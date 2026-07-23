# 恢复演练（每季一次，RTO≤4h——01 §8）
1. 新机器: 安装 docker; git clone; 复制 .env.prod。
2. `docker compose -f docker-compose.prod.yml up -d db` 等健康。
3. `gunzip -c db_<最近>.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U scm scm`
4. 附件: `docker run --rm -v supply-chain_uploads:/data -v $PWD:/backup alpine tar xzf /backup/uploads_<最近>.tar.gz -C /data`
5. `ops/deploy.sh`（跳过迁移亦可——备份已含 schema）。
6. 验收: /api/health ok:true; 登录; 抽查 3 张单据与流水一致; 记录耗时于本文件底部演练日志。

## 演练日志
| 日期 | 执行人 | 耗时 | 结果 |
|---|---|---|---|
