import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import type {
  HostTeam,
  ModelOfferingEntitlement,
  TeamMember,
} from "@/features/identity/identity-client";

type Grant = Pick<ModelOfferingEntitlement, "subjectType" | "subjectId">;
const signature = (grants: Grant[]) =>
  JSON.stringify(grants.map((g) => `${g.subjectType}:${g.subjectId}`).sort());

/** A single draft replaces the complete grant set once. No competing toggle requests. */
export function ModelAccessEditor({
  grants,
  teams,
  members,
  save,
  onSaved,
  onDirtyChange,
}: {
  grants: Grant[];
  teams: HostTeam[];
  members: TeamMember[];
  save: (grants: Grant[]) => Promise<Grant[]>;
  onSaved: (grants: Grant[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(grants);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = signature(draft) !== signature(grants);
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
    return () => onDirtyChange?.(false);
  }, [dirty, busy, onDirtyChange]);
  const has = (type: "user" | "team", id: string) =>
    draft.some((g) => g.subjectType === type && g.subjectId === id);
  const matches = (name: string) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  function toggle(subjectType: "user" | "team", subjectId: string, checked: boolean) {
    setSaved(false);
    setDraft((current) => {
      const remaining = current.filter(
        (g) => g.subjectType !== subjectType || g.subjectId !== subjectId,
      );
      return checked ? [...remaining, { subjectType, subjectId }] : remaining;
    });
  }
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const next = await save(draft);
      setDraft(next);
      onSaved(next);
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4 border-t pt-4">
      <Input
        aria-label={t("access.search")}
        placeholder={t("access.search")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <fieldset disabled={busy} className="space-y-4">
        <div>
          <h4 className="mb-2 text-sm font-medium">{t("settings.tabs.teams")}</h4>
          {teams
            .filter((team) => matches(team.name))
            .map((team) => (
              <label key={team.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>{team.id === "host_default" ? t("access.everyone") : team.name}</span>
                <Switch
                  disabled={busy}
                  checked={has("team", team.id)}
                  onCheckedChange={(checked) => toggle("team", team.id, checked)}
                />
              </label>
            ))}
        </div>
        <div>
          <h4 className="mb-2 text-sm font-medium">{t("settings.tabs.users")}</h4>
          {members
            .filter((member) => matches(member.username))
            .map((member) => {
              const inherited = teams.filter(
                (team) =>
                  has("team", team.id) &&
                  (team.id === "host_default" || team.memberIds.includes(member.id)),
              );
              const privileged = member.role === "owner" || member.role === "admin";
              return (
                <label
                  key={member.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <span className="min-w-0">
                    <span className="block break-words">{member.username}</span>
                    {(privileged || inherited.length > 0) && (
                      <span className="block text-xs text-muted-foreground">
                        {privileged
                          ? t("access.adminAccess")
                          : t("access.inherited", {
                              teams: inherited
                                .map((team) =>
                                  team.id === "host_default" ? t("access.everyone") : team.name,
                                )
                                .join(", "),
                            })}
                      </span>
                    )}
                  </span>
                  <Switch
                    checked={privileged || has("user", member.id)}
                    disabled={busy || privileged}
                    onCheckedChange={(checked) => toggle("user", member.id, checked)}
                  />
                </label>
              );
            })}
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">{t("access.directHelp")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t("access.saveError")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!dirty || busy} onClick={() => void submit()}>
          {t(busy ? "access.saving" : "access.save")}
        </Button>
        <Button
          variant="ghost"
          disabled={!dirty || busy}
          onClick={() => {
            setDraft(grants);
            setError(false);
            setSaved(false);
          }}
        >
          {t("common.cancel")}
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {dirty ? t("access.unsaved") : saved ? t("access.saved") : ""}
        </span>
      </div>
    </div>
  );
}
