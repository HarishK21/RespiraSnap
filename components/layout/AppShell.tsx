"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fadeUp, hoverGlow, pageTransition } from "@/components/motion/presets";
import { Divider, GlassCard, HintText, IconButton, Pill, Toast } from "@/components/ui/primitives";
import styles from "./AppShell.module.css";

type AppShellProps = {
  children: ReactNode;
  reducedMotion: boolean;
  onToggleReducedMotion: () => void;
  demoMode: boolean;
  onToggleDemoMode: () => void;
  reducedMotionSource?: "system" | "manual";
  className?: string;
  contentClassName?: string;
  passThrough?: boolean;
};

function cx(...classNames: Array<string | undefined | null | false>) {
  return classNames.filter(Boolean).join(" ");
}

type ToggleProps = {
  label: string;
  hint: string;
  active: boolean;
  onToggle: () => void;
};

function ToggleRow({ label, hint, active, onToggle }: ToggleProps) {
  return (
    <button type="button" className={styles.toggleRow} onClick={onToggle} aria-pressed={active}>
      <span className={styles.toggleRowLabel}>
        <span className={styles.toggleLabel}>{label}</span>
        <span className={styles.toggleHint}>{hint}</span>
      </span>
      <span className={cx(styles.toggleTrack, active && styles.toggleActive)}>
        <span className={styles.toggleKnob} />
      </span>
    </button>
  );
}

export default function AppShell({
  children,
  reducedMotion,
  onToggleReducedMotion,
  demoMode,
  onToggleDemoMode,
  reducedMotionSource = "system",
  className,
  contentClassName,
  passThrough = false
}: AppShellProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const flashToast = (message: string) => {
    setToastMessage(message);
    setToastVisible(true);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setToastVisible(false);
    }, 1700);
  };

  const handleReducedMotionToggle = () => {
    const nextState = !reducedMotion;
    onToggleReducedMotion();
    flashToast(nextState ? "Reduced motion enabled" : "Reduced motion disabled");
  };

  const handleDemoModeToggle = () => {
    const nextState = !demoMode;
    onToggleDemoMode();
    flashToast(nextState ? "Demo mode enabled" : "Demo mode disabled");
  };

  return (
    <MotionConfig reducedMotion={reducedMotion ? "always" : "never"}>
      <motion.div
        className={cx(styles.shell, passThrough && styles.passThrough, className)}
        initial={pageTransition.initial}
        animate={pageTransition.animate}
        exit={pageTransition.exit}
      >
        <header className={cx(styles.topBar, passThrough && styles.interactive)}>
          <div className={styles.brandWrap}>
            <p className={styles.brand}>RespiraSnap</p>
            <Pill>15s Respiratory Snapshot</Pill>
          </div>

          <div className={cx(styles.controls, passThrough && styles.interactive)}>
            <motion.div {...hoverGlow} transition={{ duration: 0.2 }}>
              <IconButton
                className={styles.settingsButton}
                aria-expanded={settingsOpen}
                aria-label="Open display controls"
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M4 6.5h16M7 12h10M10 17.5h4"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
              </IconButton>
            </motion.div>

            <AnimatePresence>
              {settingsOpen ? (
                <motion.div
                  className={styles.settingsPanelWrap}
                  variants={fadeUp}
                  initial="hidden"
                  animate="visible"
                  exit="hidden"
                >
                  <GlassCard className={styles.settingsPanel}>
                    <ToggleRow
                      label="Reduced Motion"
                      hint="Match system or override"
                      active={reducedMotion}
                      onToggle={handleReducedMotionToggle}
                    />
                    <Divider className={styles.panelDivider} />
                    <ToggleRow
                      label="Demo Mode"
                      hint="Preview without committing"
                      active={demoMode}
                      onToggle={handleDemoModeToggle}
                    />
                    <HintText className={styles.sourceHint}>
                      Reduced motion source: {reducedMotionSource}
                    </HintText>
                  </GlassCard>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </header>

        <div className={cx(styles.content, contentClassName)}>{children}</div>
      </motion.div>

      <Toast visible={toastVisible} message={toastMessage} />
    </MotionConfig>
  );
}
