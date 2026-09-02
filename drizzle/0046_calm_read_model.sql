-- 外部 BI 热路径不得重复解析 10 万级 JSON staging。
-- 本表仅缓存可重建的门禁后读模型；source_binding 精确绑定当前成功批次，
-- 不匹配时读取方 fail closed，staging/evidence 仍是唯一证据权威。
CREATE TABLE "report_read_model_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"source_binding" text NOT NULL,
	"payload" jsonb NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
