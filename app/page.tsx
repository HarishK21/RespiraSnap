"use client";

import { useState } from "react";
import OrbScene from "@/components/OrbScene";
import styles from "./page.module.css";

export default function HomePage() {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [zoomRequestId, setZoomRequestId] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const handleStart = () => {
    if (isTransitioning) return;
    setZoomRequestId((current) => current + 1);
  };

  return (
    <main className={styles.main}>
      <OrbScene
        reducedMotion={reducedMotion}
        zoomRequestId={zoomRequestId}
        onTransitionChange={setIsTransitioning}
      />

      <div className={`${styles.overlay} ${isTransitioning ? styles.overlayHidden : ""}`}>
        <header className={styles.topBar}>
          <div className={styles.brandWrap}>
            <p className={styles.brand}>RespiraSnap</p>
            <span className={styles.modePill}>15s Respiratory Snapshot</span>
          </div>
          <button
            type="button"
            className={styles.motionToggle}
            onClick={() => setReducedMotion((prev) => !prev)}
            aria-pressed={reducedMotion}
          >
            {reducedMotion ? "Reduced Motion: On" : "Reduced Motion: Off"}
          </button>
        </header>

        <section className={styles.hero}>
          <h1 className={styles.title}>Breathing Snapshot</h1>
          <p className={styles.subtitle}>
            Start your breathing snapshot with a single 15 second capture.
          </p>
          <p className={styles.disclaimer}>Indicator only - not a diagnosis.</p>
          <button
            type="button"
            className={styles.cta}
            onClick={handleStart}
            disabled={isTransitioning}
          >
            Start Breathing Snapshot
          </button>
          <p className={styles.hint}>Tip: click the model to begin.</p>
        </section>
      </div>
    </main>
  );
}
