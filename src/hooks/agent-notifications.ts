import { useEffect, useRef } from "react";
import { areNotificationsEnabled } from "@/hooks/agent-state-persistence";
import type { Session } from "@/hooks/agent-state-types";

export function useDesktopNotification(
  triggerMap: Record<string, unknown>,
  title: string,
  activeSessionId: string | null,
  sessions: Session[],
  selectSession: (id: string) => void,
) {
  const prevKeysRef = useRef<Set<string>>(new Set());
  const notificationsRef = useRef<Notification[]>([]);
  useEffect(() => {
    const prevKeys = prevKeysRef.current;
    const nowKeys = new Set(Object.keys(triggerMap));
    const newNotifications: Notification[] = [];

    for (const sessionId of nowKeys) {
      if (
        !prevKeys.has(sessionId) &&
        sessionId !== activeSessionId &&
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
            window.focus();
            selectSession(sessionId);
          };
          newNotifications.push(notification);
        }
      }
    }

    prevKeysRef.current = nowKeys;
    notificationsRef.current = newNotifications;
    const createdNotifications = newNotifications;

    return () => {
      for (const notification of createdNotifications) {
        notification.onclick = null;
        notification.close();
      }
      if (notificationsRef.current === createdNotifications) {
        notificationsRef.current = [];
      }
    };
  }, [triggerMap, title, activeSessionId, sessions, selectSession]);
}
