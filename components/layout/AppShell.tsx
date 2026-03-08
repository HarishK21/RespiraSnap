"use client";

import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { fadeUp, hoverGlow, pageTransition } from "@/components/motion/presets";
import { Divider, GlassCard, HintText, IconButton, Pill, Toast } from "@/components/ui/primitives";
import { useAuthUser } from "@/hooks/useAuthUser";
import { useBackboardIdentity } from "@/hooks/useBackboardIdentity";
import { useSessionAnalysis } from "@/hooks/useSessionAnalysis";
import { useSessionVideo } from "@/hooks/useSessionVideo";
import { clearClientRespiraData } from "@/lib/client/resetData";
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
  const [isMounted, setIsMounted] = useState(false);
  const [settingsPosition, setSettingsPosition] = useState({
    top: 0,
    left: 0,
    width: 300
  });
  const [resetOpen, setResetOpen] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState("");
  const [toastMessage, setToastMessage] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const settingsTriggerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { user, isLoading, logout } = useAuthUser();
  const { deviceId, assistantId } = useBackboardIdentity();
  const { clearAllSessionAnalysis } = useSessionAnalysis();
  const { clearSessionVideo } = useSessionVideo();
  const allowResetAllDemo = process.env.NEXT_PUBLIC_DEMO_RESET_ALL === "true";

  useEffect(() => {
    setIsMounted(true);
  }, []);

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

  const syncSettingsPosition = useCallback(() => {
    if (typeof window === "undefined") return;

    const trigger = settingsTriggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const gutter = 12;
    const maxWidth = Math.max(180, window.innerWidth - gutter * 2);
    const width = Math.min(300, window.innerWidth * 0.78, maxWidth);
    const left = clamp(rect.right - width, gutter, Math.max(gutter, window.innerWidth - width - gutter));
    const top = clamp(rect.bottom + 8, gutter, Math.max(gutter, window.innerHeight - gutter));

    setSettingsPosition({ top, left, width });
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;

    syncSettingsPosition();

    const handleViewportChange = () => {
      syncSettingsPosition();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [settingsOpen, syncSettingsPosition]);

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

  const handleLogout = async () => {
    await logout();
    flashToast("Logged out");
    setSettingsOpen(false);
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
  };

  const handleReset = async () => {
    if (resetBusy) return;
    setResetBusy(true);
    setResetError("");

    try {
      const response = await fetch("/api/reset", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          deviceId,
          assistantId,
          resetAll: allowResetAllDemo
        })
      });

      if (!response.ok) {
        let detail = "Unable to clear saved data.";
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) detail = payload.error;
        } catch {
          // Keep fallback.
        }
        throw new Error(detail);
      }

      clearSessionVideo();
      clearAllSessionAnalysis();
      await clearClientRespiraData();

      setSettingsOpen(false);
      setResetOpen(false);
      flashToast("Data cleared");

      setTimeout(() => {
        if (typeof window !== "undefined") {
          window.location.href = "/";
        }
      }, 260);
    } catch (error) {
      setResetError(error instanceof Error ? error.message : "Unable to clear saved data.");
    } finally {
      setResetBusy(false);
    }
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
            <Pill className={styles.userPill}>
              {isLoading ? "Account: Loading" : user ? `Account: ${user.name}` : "Account: Guest"}
            </Pill>

            <motion.div {...hoverGlow} transition={{ duration: 0.2 }} ref={settingsTriggerRef}>
              <IconButton
                className={styles.settingsButton}
                aria-expanded={settingsOpen}
                aria-label="Open display controls"
                onClick={() =>
                  setSettingsOpen((open) => {
                    const nextOpen = !open;
                    if (nextOpen) {
                      requestAnimationFrame(() => syncSettingsPosition());
                    }
                    return nextOpen;
                  })
                }
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
          </div>
        </header>

        <div className={cx(styles.content, contentClassName)}>{children}</div>
      </motion.div>

      {isMounted
        ? createPortal(
            <AnimatePresence>
              {settingsOpen ? (
                <>
                  <motion.button
                    type="button"
                    aria-label="Close display controls"
                    className={styles.settingsOverlay}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setSettingsOpen(false)}
                  />
                  <motion.div
                    className={styles.settingsPanelWrap}
                    style={{
                      top: settingsPosition.top,
                      left: settingsPosition.left,
                      width: settingsPosition.width
                    }}
                    variants={fadeUp}
                    initial="hidden"
                    animate="visible"
                    exit="hidden"
                    onClick={(event) => event.stopPropagation()}
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
                      {user ? (
                        <>
                          <Divider className={styles.panelDivider} />
                          <button
                            type="button"
                            className={styles.resetButton}
                            onClick={() => {
                              setSettingsOpen(false);
                              setResetOpen(true);
                            }}
                          >
                            Reset Demo Data
                          </button>
                          <HintText className={styles.sourceHint}>Clear snapshots, baseline memory, and local cache.</HintText>
                        </>
                      ) : null}
                      <Divider className={styles.panelDivider} />
                      {isLoading ? (
                        <HintText className={styles.sourceHint}>Checking account status...</HintText>
                      ) : user ? (
                        <div className={styles.authPanel}>
                          <HintText className={styles.sourceHint}>Signed in as {user.email}</HintText>
                          <div className={styles.authLinks}>
                            <Link href="/history" className={styles.authButton} onClick={() => setSettingsOpen(false)}>
                              History
                            </Link>
                            <button type="button" className={styles.authButton} onClick={handleLogout}>
                              Log out
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className={styles.authPanel}>
                          <HintText className={styles.sourceHint}>Sign in to sync snapshots to MongoDB.</HintText>
                          <div className={styles.authLinks}>
                            <Link href="/login" className={styles.authButton} onClick={() => setSettingsOpen(false)}>
                              Login
                            </Link>
                            <Link href="/signup" className={styles.authButton} onClick={() => setSettingsOpen(false)}>
                              Sign up
                            </Link>
                          </div>
                        </div>
                      )}
                      <HintText className={styles.sourceHint}>
                        Reduced motion source: {reducedMotionSource}
                      </HintText>
                    </GlassCard>
                  </motion.div>
                </>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}

      <AnimatePresence>
        {resetOpen ? (
          <motion.div
            className={styles.resetOverlay}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => {
              if (resetBusy) return;
              setResetOpen(false);
            }}
          >
            <motion.div
              className={styles.resetModal}
              variants={fadeUp}
              initial="hidden"
              animate="visible"
              exit="hidden"
              onClick={(event) => event.stopPropagation()}
            >
              <GlassCard className={styles.resetCard}>
                <p className={styles.resetTitle}>Reset all RespiraSnap data?</p>
                <p className={styles.resetBody}>
                  This will delete all saved snapshots, baseline history, and cached reports for this device/demo.
                </p>
                {resetError ? <p className={styles.resetError}>{resetError}</p> : null}
                <div className={styles.resetActions}>
                  <button
                    type="button"
                    className={styles.resetCancel}
                    onClick={() => setResetOpen(false)}
                    disabled={resetBusy}
                  >
                    Cancel
                  </button>
                  <button type="button" className={styles.resetConfirm} onClick={handleReset} disabled={resetBusy}>
                    {resetBusy ? "Resetting..." : "Reset"}
                  </button>
                </div>
              </GlassCard>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Toast visible={toastVisible} message={toastMessage} />
    </MotionConfig>
  );
}
