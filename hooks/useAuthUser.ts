"use client";

import { useCallback, useEffect, useState } from "react";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
};

type AuthState = {
  user: AuthUser | null;
  loading: boolean;
};

let currentState: AuthState = {
  user: null,
  loading: true
};
let hydrating = false;
const subscribers = new Set<(state: AuthState) => void>();

function notify(nextState: AuthState) {
  currentState = nextState;
  subscribers.forEach((subscriber) => subscriber(nextState));
}

async function fetchCurrentUser() {
  if (hydrating) return;
  hydrating = true;

  try {
    const response = await fetch("/api/auth/me", {
      method: "GET",
      headers: {
        "content-type": "application/json"
      },
      cache: "no-store"
    });

    if (!response.ok) {
      notify({ user: null, loading: false });
      return;
    }

    const payload = (await response.json()) as { user?: AuthUser | null };
    notify({
      user: payload.user ?? null,
      loading: false
    });
  } catch {
    notify({ user: null, loading: false });
  } finally {
    hydrating = false;
  }
}

export function useAuthUser() {
  const [state, setState] = useState<AuthState>(currentState);

  useEffect(() => {
    const subscriber = (nextState: AuthState) => {
      setState(nextState);
    };

    subscribers.add(subscriber);
    if (currentState.loading) {
      void fetchCurrentUser();
    }

    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  const refresh = useCallback(async () => {
    notify({
      user: currentState.user,
      loading: true
    });
    await fetchCurrentUser();
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        }
      });
    } finally {
      notify({ user: null, loading: false });
    }
  }, []);

  const setUser = useCallback((user: AuthUser | null) => {
    notify({ user, loading: false });
  }, []);

  return {
    user: state.user,
    isLoading: state.loading,
    isAuthenticated: !!state.user,
    refresh,
    logout,
    setUser
  };
}
