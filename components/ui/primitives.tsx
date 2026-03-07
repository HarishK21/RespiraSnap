"use client";

import type { ButtonHTMLAttributes, ComponentPropsWithoutRef, ElementType, HTMLAttributes, ReactNode } from "react";
import styles from "./primitives.module.css";

type WithClassName = {
  className?: string;
};

function cx(...classNames: Array<string | undefined | null | false>) {
  return classNames.filter(Boolean).join(" ");
}

export function GlassCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx(styles.glassCard, className)} {...props} />;
}

export function GlowButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cx(styles.glowButton, className)} {...props} />;
}

export function Pill({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx(styles.pill, className)} {...props} />;
}

type SectionTitleProps<T extends ElementType> = WithClassName & {
  as?: T;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className" | "children">;

export function SectionTitle<T extends ElementType = "h2">({
  as,
  className,
  children,
  ...props
}: SectionTitleProps<T>) {
  const Comp = (as ?? "h2") as ElementType;
  return (
    <Comp className={cx(styles.sectionTitle, className)} {...props}>
      {children}
    </Comp>
  );
}

export function Divider({ className, ...props }: HTMLAttributes<HTMLHRElement>) {
  return <hr className={cx(styles.divider, className)} {...props} />;
}

export function HintText({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx(styles.hintText, className)} {...props} />;
}

export function IconButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={cx(styles.iconButton, className)} {...props} />;
}

type ToastProps = {
  visible: boolean;
  message: string;
  className?: string;
};

export function Toast({ visible, message, className }: ToastProps) {
  if (!visible) return null;
  return (
    <div className={cx(styles.toast, className)} role="status" aria-live="polite">
      {message}
    </div>
  );
}
