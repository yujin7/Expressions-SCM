ALTER TABLE "alias_exceptions" DROP CONSTRAINT "uq_alias_exc_type_value";--> statement-breakpoint
ALTER TABLE "aliases" DROP CONSTRAINT "uq_alias_type_value";--> statement-breakpoint
ALTER TABLE "alias_exceptions" ADD COLUMN "scope" text DEFAULT 'GLOBAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "aliases" ADD COLUMN "scope" text DEFAULT 'GLOBAL' NOT NULL;--> statement-breakpoint
-- 既有外部观察异常按留存的连接器上下文回填 scope；企业文件导入继续保留 GLOBAL。
-- 0039 产生的外部标识冲突使用其 canonicalScope，避免迁移后失去来源系统边界。
UPDATE "alias_exceptions"
SET "scope" = CASE
  WHEN upper(coalesce("context"->>'connector', '')) IN ('JDY', 'JIANDAOYUN') THEN 'JIANDAOYUN'
  WHEN upper(coalesce("context"->>'connector', '')) IN ('JST', 'JUSHUITAN') THEN 'JST'
  WHEN upper(coalesce("context"->>'connector', '')) IN ('YY', 'YONYOU', 'YONSUITE', 'YONBIP') THEN 'YONYOU'
  WHEN upper(coalesce("context"->>'canonicalScope', '')) IN ('JIANDAOYUN', 'JST', 'YONYOU')
    THEN upper("context"->>'canonicalScope')
  ELSE 'GLOBAL'
END;--> statement-breakpoint
ALTER TABLE "alias_exceptions" ADD CONSTRAINT "uq_alias_exc_type_scope_value" UNIQUE("alias_type","scope","raw_value");--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "uq_alias_type_scope_value" UNIQUE("alias_type","scope","raw_value");
