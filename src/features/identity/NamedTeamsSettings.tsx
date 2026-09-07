import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Trash2, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  createIdentityClient,
  type HostTeam,
  type TeamMember,
  type ModelOffering,
  type ModelPolicy,
} from "./identity-client";
import { getIdentityWorkspace } from "./workspace-identity";
import { notifySuccess } from "@/lib/notify";

export function NamedTeamsSettings({
  onDirtyChange,
}: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  const { t } = useTranslation();
  const client = useMemo(() => {
    const workspace = getIdentityWorkspace();
    return workspace?.authToken
      ? createIdentityClient({ baseUrl: workspace.serverUrl, token: workspace.authToken })
      : null;
  }, []);
  const [teams, setTeams] = useState<HostTeam[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [models, setModels] = useState<ModelOffering[]>([]);
  const [policy, setPolicy] = useState<ModelPolicy | null>(null);
  const [draft, setDraft] = useState<HostTeam | null>(null);
  const [section, setSection] = useState("members");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const everyone = draft?.id === "host_default";
  const dirty =
    !!draft && JSON.stringify(draft) !== JSON.stringify(teams.find((team) => team.id === draft.id));
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
    return () => onDirtyChange?.(false);
  }, [dirty, busy, onDirtyChange]);
  async function load() {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [nextTeams, nextMembers, nextModels, nextPolicy] = await Promise.all([
        client.teams(),
        client.members(),
        client.modelOfferings(),
        client.modelPolicy(),
      ]);
      setTeams(nextTeams);
      setMembers(nextMembers);
      setModels(nextModels);
      setPolicy(nextPolicy);
    } catch {
      setError(t("identity.teamLoadError"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function edit(team: HostTeam) {
    setDraft(team);
    setSection("members");
    setQuery("");
    setError(null);
  }
  async function save() {
    if (!client || !draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await client.saveTeam(draft, draft.id || undefined);
      setTeams((current) => [...current.filter((team) => team.id !== saved.id), saved]);
      setDraft(null);
      setQuery("");
      notifySuccess(t("access.saved"));
    } catch {
      setError(t("teams.saveError"));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!client || !draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      await client.removeTeam(draft.id);
      setTeams((current) => current.filter((team) => team.id !== draft.id));
      setDraft(null);
      setQuery("");
    } catch {
      setError(t("identity.actionError"));
    } finally {
      setBusy(false);
      setDeleting(false);
    }
  }
  function toggle(field: "memberIds" | "modelOfferingIds", id: string, checked: boolean) {
    setDraft((current) =>
      current
        ? {
            ...current,
            [field]: checked
              ? [...current[field], id]
              : current[field].filter((value) => value !== id),
          }
        : current,
    );
  }
  if (loading) return <Skeleton className="h-40 w-full" />;
  if (!client) return <p>{t("identity.teamRemoteOnly")}</p>;
  const matches = (name: string) => name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const errorRow = error && (
    <div role="alert" className="text-sm text-destructive">
      {error}
      {!draft && (
        <Button variant="ghost" onClick={() => void load()}>
          {t("identity.retry")}
        </Button>
      )}
    </div>
  );
  if (!draft)
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            className="min-w-0 flex-1"
            aria-label={t("teams.search")}
            placeholder={t("teams.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button
            onClick={() =>
              edit({
                id: "",
                name: "",
                memberIds: [],
                modelOfferingIds: [],
                allowByok: true,
                allowByos: true,
              })
            }
          >
            <Plus />
            {t("teams.create")}
          </Button>
        </div>
        {errorRow}
        <div className="divide-y">
          {teams
            .filter((team) => matches(team.name))
            .map((team) => (
              <button
                key={team.id}
                type="button"
                className="flex w-full items-center gap-3 rounded-md px-2 py-4 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => edit(team)}
              >
                <Users className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium">
                    {team.id === "host_default" ? t("access.everyone") : team.name}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t("teams.summary", {
                      members: t("teams.peopleCount", { count: team.memberIds.length }),
                      models: t("teams.modelCount", { count: team.modelOfferingIds.length }),
                    })}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">{t("teams.edit")}</span>
              </button>
            ))}
          {!teams.some((team) => matches(team.name)) && (
            <p className="py-6 text-sm text-muted-foreground">{t("teams.noResults")}</p>
          )}
        </div>
      </div>
    );
  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setDraft(null);
            setQuery("");
            setError(null);
          }}
        >
          <ArrowLeft />
          {t("settings.tabs.teams")}
        </Button>
        {draft.id && !everyone && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setDeleting(true)}
          >
            <Trash2 />
            {t("teams.delete")}
          </Button>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="team-name">{t("teams.name")}</Label>
        <Input
          id="team-name"
          required
          maxLength={80}
          disabled={busy || everyone}
          value={everyone ? t("access.everyone") : draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </div>
      <div className="flex flex-wrap gap-1 border-b pb-3" role="group" aria-label={t("teams.edit")}>
        {["members", "models", "personal"].map((tab) => (
          <Button
            type="button"
            key={tab}
            size="sm"
            variant={section === tab ? "secondary" : "ghost"}
            aria-pressed={section === tab}
            onClick={() => {
              setSection(tab);
              setQuery("");
            }}
          >
            {t(`teams.tabs.${tab}`)}
          </Button>
        ))}
      </div>
      <fieldset disabled={busy} className="space-y-3">
        {section === "members" && (
          <>
            {everyone ? (
              <p className="text-sm text-muted-foreground">{t("teams.everyoneHelp")}</p>
            ) : (
              <Input
                aria-label={t("access.searchPeople")}
                placeholder={t("access.searchPeople")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            )}
            {members
              .filter((member) => matches(member.username))
              .map((member) => (
                <label key={member.id} className="flex items-center gap-3 py-2 text-sm">
                  <Checkbox
                    disabled={busy || everyone}
                    checked={everyone || draft.memberIds.includes(member.id)}
                    onCheckedChange={(checked) => toggle("memberIds", member.id, checked === true)}
                  />
                  <span className="min-w-0 break-words">
                    {member.username}
                    <span className="block text-xs text-muted-foreground">{member.email}</span>
                  </span>
                </label>
              ))}
          </>
        )}
        {section === "models" && (
          <>
            {models.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("teams.noModels")}</p>
            )}
            {models.map((model) => {
              const inherited =
                !everyone &&
                teams
                  .find((team) => team.id === "host_default")
                  ?.modelOfferingIds.includes(model.id);
              return (
                <label key={model.id} className="flex items-center gap-3 py-2 text-sm">
                  <Checkbox
                    disabled={busy}
                    checked={draft.modelOfferingIds.includes(model.id)}
                    onCheckedChange={(checked) =>
                      toggle("modelOfferingIds", model.id, checked === true)
                    }
                  />
                  <span>
                    {model.displayName}
                    {inherited && (
                      <span className="block text-xs text-muted-foreground">
                        {t("access.inherited", { teams: t("access.everyone") })}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </>
        )}
        {section === "personal" && (
          <>
            {(["allowByok", "allowByos"] as const).map((kind) => {
              const blocked =
                !policy?.host[kind] ||
                (!everyone && teams.find((team) => team.id === "host_default")?.[kind] === false);
              return (
                <label key={kind} className="flex items-center justify-between gap-4 py-3">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{t(`teams.${kind}`)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {blocked ? t("teams.blocked") : t(`teams.${kind}Help`)}
                    </span>
                  </span>
                  <Switch
                    checked={draft[kind]}
                    disabled={busy || blocked}
                    onCheckedChange={(checked) => setDraft({ ...draft, [kind]: checked })}
                  />
                </label>
              );
            })}
            <p className="text-xs text-muted-foreground">{t("teams.policyHelp")}</p>
          </>
        )}
      </fieldset>
      {errorRow}
      <div className="flex flex-wrap gap-2 border-t pt-4">
        <Button type="submit" disabled={busy || !draft.name.trim()}>
          {t(busy ? "access.saving" : "access.save")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setDraft(null);
            setQuery("");
            setError(null);
          }}
        >
          {t("common.cancel")}
        </Button>
      </div>
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("teams.delete")}</AlertDialogTitle>
            <AlertDialogDescription>{t("teams.deleteHelp")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              {t("teams.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
