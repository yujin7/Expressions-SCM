"use client";

import styles from "./page.module.css";

export default function ElectronicLabelError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className={styles.page}>
      <section className={styles.notFound} role="alert" aria-live="assertive">
        <p className={styles.eyebrow}>ELECTRONIC LABEL</p>
        <h1>电子标签暂时无法加载</h1>
        <p>请稍后重试。若问题持续，请记录当前链接和时间并联系产品责任主体。</p>
        <button className={styles.retryButton} type="button" onClick={reset}>
          重新加载
        </button>
      </section>
    </main>
  );
}
