import styles from "./page.module.css";

export default function ElectronicLabelNotFound() {
  return (
    <main className={styles.page}>
      <section className={styles.notFound}>
        <p className={styles.eyebrow}>ELECTRONIC LABEL</p>
        <h1>电子标签不存在</h1>
        <p>链接可能不完整、已失效，或对应标签尚未发布。请重新扫描产品包装上的二维码。</p>
      </section>
    </main>
  );
}
