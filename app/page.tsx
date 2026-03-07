"use client";

import { motion } from "framer-motion";
import AppShell from "@/components/layout/AppShell";
import { fadeUp, hoverGlow, staggerChildren } from "@/components/motion/presets";
import OrbScene from "@/components/OrbScene";
import { GlowButton, HintText, SectionTitle } from "@/components/ui/primitives";
import { useDemoMode } from "@/hooks/useDemoMode";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import { useState } from "react";
import styles from "./page.module.css";

export default function HomePage() {
  const { reducedMotion, hasOverride, toggleReducedMotion } = useReducedMotionPref();
  const { demoMode, toggleDemoMode } = useDemoMode();
  const [zoomRequestId, setZoomRequestId] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);

  const handleStart = () => {
    if (isTransitioning || demoMode) return;
    setZoomRequestId((current) => current + 1);
  };

  return (
    <main className={styles.main}>
      <OrbScene
        reducedMotion={reducedMotion}
        zoomRequestId={zoomRequestId}
        demoMode={demoMode}
        onTransitionChange={setIsTransitioning}
      />

      <AppShell
        reducedMotion={reducedMotion}
        onToggleReducedMotion={toggleReducedMotion}
        reducedMotionSource={hasOverride ? "manual" : "system"}
        demoMode={demoMode}
        onToggleDemoMode={toggleDemoMode}
        passThrough
        className={`${styles.overlay} ${isTransitioning ? styles.overlayHidden : ""}`}
        contentClassName={styles.heroWrap}
      >
        <motion.section
          className={styles.hero}
          variants={staggerChildren}
          initial={reducedMotion ? "visible" : "hidden"}
          animate="visible"
        >
          <motion.div variants={fadeUp}>
            <SectionTitle as="h1" className={styles.title}>
              Breathing Snapshot
            </SectionTitle>
          </motion.div>

          <motion.div variants={fadeUp}>
            <p className={styles.subtitle}>
              Start your breathing snapshot with a single 15 second capture.
            </p>
          </motion.div>

          <motion.div variants={fadeUp}>
            <HintText className={styles.disclaimer}>Indicator only - not a diagnosis.</HintText>
          </motion.div>

          <motion.div variants={fadeUp} {...(reducedMotion ? {} : hoverGlow)}>
            <GlowButton type="button" className={styles.cta} onClick={handleStart} disabled={isTransitioning || demoMode}>
              Start Breathing Snapshot
            </GlowButton>
          </motion.div>

          <motion.div variants={fadeUp}>
            <HintText className={styles.hint}>
              {demoMode ? "Demo mode active. Disable it to enter capture flow." : "Tip: click the model to begin."}
            </HintText>
          </motion.div>
        </motion.section>
      </AppShell>
    </main>
  );
}
