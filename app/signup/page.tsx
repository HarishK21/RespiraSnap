"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import AppShell from "@/components/layout/AppShell";
import { GlassCard, GlowButton, HintText, SectionTitle } from "@/components/ui/primitives";
import { useAuthUser } from "@/hooks/useAuthUser";
import { useDemoMode } from "@/hooks/useDemoMode";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import styles from "@/app/auth.module.css";

type SignupResponse = {
  user?: {
    id: string;
    email: string;
    name: string;
    createdAt: string;
  };
  error?: string;
};

async function safeJson<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export default function SignupPage() {
  const router = useRouter();
  const { reducedMotion, hasOverride, toggleReducedMotion } = useReducedMotionPref();
  const { demoMode, toggleDemoMode } = useDemoMode();
  const { user, isLoading, setUser } = useAuthUser();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isLoading && user) {
      router.replace("/record");
    }
  }, [isLoading, router, user]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name,
          email,
          password
        })
      });

      const payload = (await safeJson<SignupResponse>(response)) ?? {};
      if (!response.ok || !payload.user) {
        throw new Error(payload.error || "Signup failed.");
      }

      setUser(payload.user);
      router.push("/record");
    } catch (signupError) {
      setError(signupError instanceof Error ? signupError.message : "Signup failed.");
    } finally {
      setSubmitting(false);
    }
  };

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
        <GlassCard className={styles.card}>
          <SectionTitle as="h1" className={styles.title}>
            Create Account
          </SectionTitle>
          <p className={styles.subtitle}>Your snapshots and preferences will sync to MongoDB.</p>

          <form className={styles.form} onSubmit={onSubmit}>
            <label className={styles.field}>
              <span className={styles.label}>Name</span>
              <input
                className={styles.input}
                type="text"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Email</span>
              <input
                className={styles.input}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Password</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={8}
              />
            </label>

            {error ? <p className={styles.error}>{error}</p> : null}

            <div className={styles.actions}>
              <GlowButton type="submit" disabled={submitting}>
                {submitting ? "Creating..." : "Sign Up"}
              </GlowButton>
              <Link href="/login" className={styles.ghostButton}>
                Back To Login
              </Link>
            </div>
          </form>

          <HintText className={styles.hint}>Passwords are hashed with bcrypt before storage.</HintText>
        </GlassCard>
      </AppShell>
    </main>
  );
}
