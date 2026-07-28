import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiError } from "@/server/modules/master/common";
import { getPublicElectronicLabel } from "@/server/modules/quality/service";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "产品电子标签 | 供应链系统",
  description: "化妆品产品信息与电子标签版本",
  robots: { index: false, follow: false },
};

async function loadLabel(token: string) {
  try {
    return await getPublicElectronicLabel(token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}

function displayDate(value: string | Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export default async function ElectronicLabelPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const label = await loadLabel(token);
  const { content } = label;
  const lifecycleClass = label.lifecycleState === "current"
    ? styles.current
    : label.lifecycleState === "scheduled"
      ? styles.scheduled
      : label.lifecycleState === "blocked"
        ? styles.blocked
        : styles.superseded;
  const lifecycleText = label.lifecycleState === "current"
    ? "当前有效版本"
    : label.lifecycleState === "scheduled"
      ? "待生效版本"
      : label.lifecycleState === "blocked"
        ? "监管支撑异常"
        : "历史版本";
  const regulatorySupport = ({
    active: { className: styles.supportActive, text: "监管支撑当前有效" },
    scheduled: { className: styles.supportScheduled, text: "监管支撑待生效" },
    expired: { className: styles.supportBlocked, text: "监管支撑已过期" },
    inactive: { className: styles.supportBlocked, text: "监管支撑已停用" },
    not_operative: { className: styles.supportBlocked, text: "监管支撑当前不可用" },
  } as const)[label.regulatorySupportState] ?? {
    className: styles.supportBlocked,
    text: "监管支撑状态未知",
  };

  return (
    <main className={styles.page}>
      <article className={styles.labelCard}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>PRODUCT INFORMATION · {label.marketCode}</p>
            <h1>{content.productName}</h1>
            <p className={styles.sku}>
              {label.sku.code} · {label.sku.name}
            </p>
          </div>
          <div className={styles.versionBlock} aria-label="标签版本与监管支撑状态">
            <span className={lifecycleClass}>{lifecycleText}</span>
            <span className={regulatorySupport.className}>{regulatorySupport.text}</span>
            <strong>第 {label.version} 版</strong>
            <span>生效日 {label.effectiveDate}</span>
          </div>
        </header>

        {label.lifecycleState === "blocked" ? (
          <div className={styles.blockedNotice} role="alert">
            此版本的监管支撑当前不可用，不应作为当前合规版本使用。请联系产品责任主体确认有效标签信息。
          </div>
        ) : label.lifecycleState === "scheduled" ? (
          <div className={styles.scheduledNotice} role="status">
            此版本将在 {label.effectiveDate} 生效；在此之前请以当前有效版本为准。
          </div>
        ) : label.lifecycleState === "historical" ? (
          <div className={styles.warning} role="status">
            此链接指向历史版本。请扫描产品当前标签上的二维码获取最新信息。
          </div>
        ) : null}

        <section className={styles.summaryGrid} aria-label="产品基础信息">
          <div>
            <span>责任主体</span>
            <strong>{content.responsibleEntity}</strong>
          </div>
          <div>
            <span>净含量</span>
            <strong>{content.netContent}</strong>
          </div>
          <div>
            <span>注册/备案信息</span>
            <strong>{content.registrationRef}</strong>
          </div>
          <div>
            <span>原产地</span>
            <strong>{content.origin || "未标示"}</strong>
          </div>
        </section>

        <section className={styles.section}>
          <h2>全成分</h2>
          <ul className={styles.ingredients}>
            {content.ingredients.map((ingredient, index) => (
              <li key={`${ingredient}-${index}`}>{ingredient}</li>
            ))}
          </ul>
        </section>

        <div className={styles.twoColumns}>
          {content.usage ? (
            <section className={styles.section}>
              <h2>使用方法</h2>
              <p>{content.usage}</p>
            </section>
          ) : null}
          <section className={styles.section}>
            <h2>注意事项</h2>
            <p>{content.precautions}</p>
          </section>
        </div>

        <section className={styles.factList} aria-label="批次与耐用期限信息">
          <div>
            <span>批次说明</span>
            <p>{content.batchStatement}</p>
          </div>
          <div>
            <span>耐用期限说明</span>
            <p>{content.durabilityStatement}</p>
          </div>
          <div>
            <span>责任主体地址</span>
            <p>{content.responsibleAddress}</p>
          </div>
          {content.otherMandatoryText ? (
            <div>
              <span>其他法定标示</span>
              <p>{content.otherMandatoryText}</p>
            </div>
          ) : null}
        </section>

        <aside className={styles.notice}>
          <strong>合规提示</strong>
          <p>{label.notice}</p>
        </aside>

        <footer className={styles.footer}>
          <span>发布于 {displayDate(label.publishedAt)}</span>
          <span>语言 {label.locale}</span>
          <details>
            <summary>版本校验摘要</summary>
            <code>{label.digest}</code>
          </details>
        </footer>
      </article>
    </main>
  );
}
