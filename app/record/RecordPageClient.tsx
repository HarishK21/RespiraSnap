"use client";

import AppShell from "@/components/layout/AppShell";
import { fadeIn, fadeUp, hoverGlow, staggerChildren } from "@/components/motion/presets";
import { Divider, GlassCard, GlowButton, HintText, Pill, SectionTitle } from "@/components/ui/primitives";
import { useDemoMode } from "@/hooks/useDemoMode";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

type RecordPageClientProps = {
  mode: string;
};

function modeToLabel(mode: string) {
  if (mode === "breathing") return "Breathing Snapshot";
  return "Breathing Snapshot";
}

export default function RecordPageClient({ mode }: RecordPageClientProps) {
  const router = useRouter();
  const modeLabel = modeToLabel(mode);
  const { reducedMotion, hasOverride, toggleReducedMotion } = useReducedMotionPref();
  const { demoMode, toggleDemoMode } = useDemoMode();

  return (
    <main className={styles.main}>
      <AppShell
        reducedMotion={reducedMotion}
        onToggleReducedMotion={toggleReducedMotion}
        reducedMotionSource={hasOverride ? "manual" : "system"}
        demoMode={demoMode}
        onToggleDemoMode={toggleDemoMode}
        contentClassName={styles.content}
      >
        <motion.section
          className={styles.cardWrap}
          variants={staggerChildren}
          initial={reducedMotion ? "visible" : "hidden"}
          animate="visible"
        >
          <motion.div variants={fadeIn}>
            <GlassCard className={styles.card}>
              <motion.div variants={fadeUp}>
                <Pill className={styles.modePill}>Capture</Pill>
              </motion.div>

              <motion.div variants={fadeUp}>
                <SectionTitle as="h1" className={styles.title}>
                  {modeLabel}
                </SectionTitle>
              </motion.div>

              <motion.div variants={fadeUp}>
                <p className={styles.modeMeta}>
                  Active mode: <span>{mode}</span>
                </p>
              </motion.div>

              <motion.div variants={fadeUp}>
                <Divider className={styles.divider} />
              </motion.div>

              <motion.div variants={fadeUp}>
                <HintText className={styles.copy}>Recording flow coming soon.</HintText>
              </motion.div>

              <motion.div variants={fadeUp} {...(reducedMotion ? {} : hoverGlow)}>
                <GlowButton type="button" className={styles.backButton} onClick={() => router.push("/")}>
                  Back to landing
                </GlowButton>
              </motion.div>
            </GlassCard>
          </motion.div>
        </motion.section>
      </AppShell>
    </main>
  );
}
