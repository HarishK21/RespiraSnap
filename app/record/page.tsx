import Link from "next/link";
import styles from "./page.module.css";

type RecordPageProps = {
  searchParams?: {
    mode?: string;
  };
};

function modeToLabel(mode: string) {
  if (mode === "breathing") return "Breathing Snapshot";
  return "Breathing Snapshot";
}

export default function RecordPage({ searchParams }: RecordPageProps) {
  const mode = typeof searchParams?.mode === "string" ? searchParams.mode : "breathing";
  const modeLabel = modeToLabel(mode);

  return (
    <main className={styles.main}>
      <section className={styles.card}>
        <p className={styles.brand}>RespiraSnap</p>
        <h1 className={styles.title}>{modeLabel}</h1>
        <p className={styles.modeMeta}>
          Active mode: <span>{mode}</span>
        </p>
        <p className={styles.copy}>Recording flow coming soon.</p>
        <Link href="/" className={styles.link}>
          Back to landing
        </Link>
      </section>
    </main>
  );
}
