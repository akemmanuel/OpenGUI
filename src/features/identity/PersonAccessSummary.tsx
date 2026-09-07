import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { createIdentityClient, TeamMember } from "./identity-client";

export function PersonAccessSummary({
  member,
  client,
  onClose,
}: {
  member: TeamMember;
  client: ReturnType<typeof createIdentityClient>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Array<{ id: string; name: string; sources: string[] }>>([]);
  const [teamNames, setTeamNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    async function load() {
      try {
        const [teams, models] = await Promise.all([client.teams(), client.modelOfferings()]);
        const joined = teams.filter(
          (team) => team.id === "host_default" || team.memberIds.includes(member.id),
        );
        const next = await Promise.all(
          models.map(async (model) => {
            const grants = await client.modelOfferingEntitlements(model.id);
            const sources =
              member.role === "owner" || member.role === "admin"
                ? [t("access.adminAccess")]
                : [
                    ...(grants.some(
                      (grant) => grant.subjectType === "user" && grant.subjectId === member.id,
                    )
                      ? [t("access.direct")]
                      : []),
                    ...joined
                      .filter((team) =>
                        grants.some(
                          (grant) => grant.subjectType === "team" && grant.subjectId === team.id,
                        ),
                      )
                      .map((team) =>
                        team.id === "host_default" ? t("access.everyone") : team.name,
                      ),
                  ];
            return { id: model.id, name: model.displayName, sources };
          }),
        );
        if (active) {
          setRows(next);
          setTeamNames(
            joined.map((team) => (team.id === "host_default" ? t("access.everyone") : team.name)),
          );
        }
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [client, member, attempt, t]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("access.personTitle", { name: member.username })}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : error ? (
          <div role="alert">
            <p>{t("identity.teamLoadError")}</p>
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              {t("identity.retry")}
            </Button>
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto">
            <div>
              <h3 className="text-sm font-medium">{t("settings.tabs.teams")}</h3>
              <p className="text-sm text-muted-foreground">{teamNames.join(", ")}</p>
            </div>
            <div className="divide-y">
              {rows.map((row) => (
                <div key={row.id} className="py-3">
                  <p className="text-sm font-medium">{row.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.sources.length ? row.sources.join(", ") : t("access.noAccess")}
                  </p>
                </div>
              ))}
            </div>
            {rows.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("teams.noModels")}</p>
            )}
            <p className="text-xs text-muted-foreground">{t("access.personHelp")}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
