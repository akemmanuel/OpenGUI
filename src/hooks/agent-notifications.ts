import { useEffect, useRef, useState } from "react";
import { areNotificationsEnabled } from "@/hooks/agent-state-persistence";
import type { Session } from "@/hooks/agent-state-types";

function getAppFocused() {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

function useAppFocused() {
  const [focused, setFocused] = useState(getAppFocused);

  useEffect(() => {
    const update = () => setFocused(getAppFocused());

    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);

    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
    };
  }, []);

  return focused;
}

export function useDesktopNotification(
  triggerMap: Record<string, unknown>,
  title: string,
  activeSessionId: string | null,
  sessions: Session[],
  selectSession: (id: string) => void,
) {
  const appFocused = useAppFocused();
  const prevKeysRef = useRef<Set<string>>(new Set());
  const notificationsRef = useRef<Notification[]>([]);

  useEffect(() => {
    return () => {
      for (const notification of notificationsRef.current) {
        notification.onclick = null;
        notification.close();
      }
      notificationsRef.current = [];
    };
  }, []);

  useEffect(() => {
    const prevKeys = prevKeysRef.current;
    const nowKeys = new Set(Object.keys(triggerMap));
    const createdNotifications: Notification[] = [];

    for (const sessionId of nowKeys) {
      const shouldNotify = sessionId !== activeSessionId || !appFocused;
      if (
        !prevKeys.has(sessionId) &&
        shouldNotify &&
        areNotificationsEnabled() &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        const session = sessions.find((s) => s.id === sessionId);
        if (session) {
          const sessionTitle = session.title || "Untitled";
          const notification = new Notification(title, {
            body: sessionTitle,
          });
          notification.onclick = () => {
            if (typeof window.electronAPI !== "undefined" && window.electronAPI.focus) {
              void window.electronAPI.focus();
            } else {
              window.focus();
            }
            selectSession(sessionId);
          };
          createdNotifications.push(notification);
        }
      }
    }

    prevKeysRef.current = nowKeys;
    notificationsRef.current.push(...createdNotifications);
  }, [triggerMap, title, activeSessionId, sessions, selectSession, appFocused]);
}
