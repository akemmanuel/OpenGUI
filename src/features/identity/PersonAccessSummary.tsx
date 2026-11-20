import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getProjectName } from "@/lib/path";
import type { createIdentityClient, PathGrant, TeamMember } from "./identity-client";

export function PersonAccessSummary({
  member,
  client,
  folderAccess,
  onManageFolders,
  onClose,
}: {
  member: TeamMember;
  client: ReturnType<typeof createIdentityClient>;
  folderAccess?: "unrestricted" | "granted";
  onManageFolders?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Array<{ id: string; name: string; sources: string[] }>>([]);
  const [teamNames, setTeamNames] = useState<string[]>([]);
  const [folders, setFolders] = useState<PathGrant[] | null>(null);
  const [folderError, setFolderError] = useState(false);
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
  useEffect(() => {
    if (folderAccess !== "granted") return;
    let active = true;
    setFolders(null);
    setFolderError(false);
    void client.memberPathGrants(member.id).then(
      (result) => {
        if (active) setFolders(result.grants);
      },
      () => {
        if (active) setFolderError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [client, member.id, folderAccess, attempt]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
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
              <h3 className="pb-1 text-sm font-medium">{t("settings.tabs.models")}</h3>
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
            <p className="text-xs leading-5 text-muted-foreground">{t("access.personHelp")}</p>
            {folderAccess && (
              <section className="space-y-2 border-t pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">{t("settings.tabs.paths")}</h3>
                  {onManageFolders && (
                    <Button type="button" variant="outline" size="sm" onClick={onManageFolders}>
                      {t("access.manageFolders")}
                    </Button>
                  )}
                </div>
                {folderAccess === "unrestricted" ? (
                  <p className="text-sm text-muted-foreground">
                    {t("identity.pathGrants.unrestricted")}
                  </p>
                ) : folderError ? (
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>{t("identity.teamLoadError")}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAttempt((value) => value + 1)}
                    >
                      {t("identity.retry")}
                    </Button>
                  </div>
                ) : !folders ? (
                  <Skeleton className="h-10 w-full" />
                ) : folders.length > 0 ? (
                  <ul className="divide-y rounded-lg border">
                    {folders.map((grant) => (
                      <li
                        key={grant.root}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {getProjectName(grant.root, grant.root)}
                          </p>
                          <p
                            className="truncate font-mono text-xs text-muted-foreground"
                            title={grant.root}
                          >
                            {grant.root}
                          </p>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {t(
                            grant.access === "read"
                              ? "identity.pathGrants.readOnly"
                              : "identity.pathGrants.readWrite",
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("access.noFolders")}</p>
                )}
              </section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
