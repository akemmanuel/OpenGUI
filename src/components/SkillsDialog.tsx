/**
 * Skills management dialog.
 *
 * Lists discovered skills and manages skill paths/URLs in the config.
 */

import { BookOpen, FolderOpen, Globe, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillInfo {
	name: string;
	description: string;
	location: string;
	content: string;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface SkillsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function SkillsDialog({ open, onOpenChange }: SkillsDialogProps) {
	const bridge = window.electronAPI?.opencode;

	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const [paths, setPaths] = useState<string[]>([]);
	const [urls, setUrls] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);

	const [newPath, setNewPath] = useState("");
	const [newUrl, setNewUrl] = useState("");

	const refresh = useCallback(async () => {
		if (!bridge) return;
		const [skillsRes, configRes] = await Promise.all([
			bridge.getSkills(),
			bridge.getConfig(),
		]);
		if (skillsRes.success && skillsRes.data) {
			setSkills(skillsRes.data);
		}
		if (configRes.success && configRes.data?.skills) {
			setPaths(configRes.data.skills.paths ?? []);
			setUrls(configRes.data.skills.urls ?? []);
		}
		setLoading(false);
	}, [bridge]);

	useEffect(() => {
		if (open) {
			setLoading(true);
			refresh();
		}
	}, [open, refresh]);

	const saveConfig = async (nextPaths: string[], nextUrls: string[]) => {
		if (!bridge) return;
		setSaving(true);
		try {
			await bridge.updateConfig({
				skills: { paths: nextPaths, urls: nextUrls },
			});
			setPaths(nextPaths);
			setUrls(nextUrls);
			await new Promise((r) => setTimeout(r, 500));
			const skillsRes = await bridge.getSkills();
			if (skillsRes.success && skillsRes.data) {
				setSkills(skillsRes.data);
			}
		} finally {
			setSaving(false);
		}
	};

	const addPath = async () => {
		const trimmed = newPath.trim();
		if (!trimmed || paths.includes(trimmed)) return;
		setNewPath("");
		await saveConfig([...paths, trimmed], urls);
	};

	const removePath = async (path: string) => {
		await saveConfig(
			paths.filter((p) => p !== path),
			urls,
		);
	};

	const addUrl = async () => {
		const trimmed = newUrl.trim();
		if (!trimmed || urls.includes(trimmed)) return;
		setNewUrl("");
		await saveConfig(paths, [...urls, trimmed]);
	};

	const removeUrl = async (url: string) => {
		await saveConfig(
			paths,
			urls.filter((u) => u !== url),
		);
	};

	const getSourceType = (location: string): "local" | "url" => {
		if (location.startsWith("http://") || location.startsWith("https://")) {
			return "url";
		}
		return "local";
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md max-h-[80vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>Skills</DialogTitle>
					<DialogDescription>
						Manage skill sources and view discovered skills.
					</DialogDescription>
				</DialogHeader>

				<div className="overflow-y-auto flex-1 space-y-6 pr-1">
					{loading ? (
						<div className="flex items-center justify-center py-8">
							<Spinner className="size-5" />
						</div>
					) : (
						<>
							{/* Discovered skills */}
							<div className="space-y-3">
								<h3 className="text-sm font-medium">Available Skills</h3>

								{skills.length === 0 ? (
									<div className="text-center py-4 text-sm text-muted-foreground">
										No skills discovered.
									</div>
								) : (
									<div className="space-y-2">
										{skills.map((skill) => {
											const source = getSourceType(skill.location);
											return (
												<div
													key={skill.name}
													className="flex items-start gap-3 rounded-lg border p-3 bg-card"
												>
													<BookOpen className="size-4 text-muted-foreground shrink-0 mt-0.5" />
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-2">
															<span className="text-sm font-medium">
																{skill.name}
															</span>
															<Badge
																variant="secondary"
																className="text-[10px] px-1.5 py-0"
															>
																{source === "url" ? "Remote" : "Local"}
															</Badge>
														</div>
														<p className="text-xs text-muted-foreground mt-0.5">
															{skill.description}
														</p>
														<p className="text-[10px] text-muted-foreground font-mono truncate mt-1">
															{skill.location}
														</p>
													</div>
												</div>
											);
										})}
									</div>
								)}
							</div>

							{/* Skill paths */}
							<div className="space-y-3">
								<h3 className="text-sm font-medium">Skill Paths</h3>

								{paths.map((path) => (
									<div
										key={path}
										className="flex items-center gap-2 rounded-md border px-3 py-1.5"
									>
										<FolderOpen className="size-3.5 text-muted-foreground shrink-0" />
										<span className="text-xs font-mono flex-1 truncate">
											{path}
										</span>
										<Button
											variant="ghost"
											size="sm"
											className="h-6 w-6 p-0 text-destructive hover:text-destructive"
											onClick={() => removePath(path)}
											disabled={saving}
										>
											<Trash2 className="size-3" />
										</Button>
									</div>
								))}

								<div className="flex gap-2">
									<Input
										value={newPath}
										onChange={(e) => setNewPath(e.target.value)}
										placeholder="/path/to/skills/folder"
										className="font-mono text-xs h-8 flex-1"
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												addPath();
											}
										}}
									/>
									<Button
										size="sm"
										variant="outline"
										className="h-8"
										onClick={addPath}
										disabled={saving || !newPath.trim()}
									>
										{saving ? (
											<Spinner className="size-3.5" />
										) : (
											<Plus className="size-3.5" />
										)}
									</Button>
								</div>
							</div>

							{/* Skill URLs */}
							<div className="space-y-3">
								<h3 className="text-sm font-medium">Skill URLs</h3>

								{urls.map((url) => (
									<div
										key={url}
										className="flex items-center gap-2 rounded-md border px-3 py-1.5"
									>
										<Globe className="size-3.5 text-muted-foreground shrink-0" />
										<span className="text-xs font-mono flex-1 truncate">
											{url}
										</span>
										<Button
											variant="ghost"
											size="sm"
											className="h-6 w-6 p-0 text-destructive hover:text-destructive"
											onClick={() => removeUrl(url)}
											disabled={saving}
										>
											<Trash2 className="size-3" />
										</Button>
									</div>
								))}

								<div className="flex gap-2">
									<Input
										value={newUrl}
										onChange={(e) => setNewUrl(e.target.value)}
										placeholder="https://example.com/.well-known/skills/"
										className="font-mono text-xs h-8 flex-1"
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												addUrl();
											}
										}}
									/>
									<Button
										size="sm"
										variant="outline"
										className="h-8"
										onClick={addUrl}
										disabled={saving || !newUrl.trim()}
									>
										{saving ? (
											<Spinner className="size-3.5" />
										) : (
											<Plus className="size-3.5" />
										)}
									</Button>
								</div>
							</div>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
