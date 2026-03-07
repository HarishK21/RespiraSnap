import type { Transition, Variants } from "framer-motion";

const easeOut = [0.22, 1, 0.36, 1] as const;

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      duration: 0.4,
      ease: easeOut
    }
  }
};

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.48,
      ease: easeOut
    }
  }
};

export const staggerChildren: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.06
    }
  }
};

export const hoverGlow = {
  whileHover: {
    y: -1,
    scale: 1.01,
    boxShadow: "0 0 26px rgba(106, 223, 255, 0.36), 0 10px 24px rgba(2, 9, 18, 0.52)"
  },
  whileTap: {
    y: 0,
    scale: 0.99
  }
} as const;

export const pageTransition = {
  initial: { opacity: 0, y: 10 },
  animate: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.46,
      ease: easeOut
    }
  },
  exit: {
    opacity: 0,
    y: 8,
    transition: {
      duration: 0.24,
      ease: [0.4, 0, 1, 1]
    }
  }
} as const;

export const quickFade: Transition = {
  duration: 0.2,
  ease: "easeOut"
};
