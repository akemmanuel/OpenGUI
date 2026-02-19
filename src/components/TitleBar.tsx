import { Minimize, Minus, Plus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { ThemeToggle } from "./ThemeToggle";

type WindowButtonKind = "default" | "mac";
type MacButtonTone = "close" | "minimize" | "maximize";

function WindowButton({
	icon,
	onClick,
	isClose = false,
	kind = "default",
	macTone = "minimize",
}: {
	icon: React.ReactNode;
	onClick: () => void;
	isClose?: boolean;
	kind?: WindowButtonKind;
	macTone?: MacButtonTone;
}) {
	if (kind === "mac") {
		const colorClasses =
			macTone === "close"
				? "bg-[#ff5f57] border-[#e14640]"
				: macTone === "maximize"
					? "bg-[#28c840] border-[#1fa533]"
					: "bg-[#ffbd2e] border-[#df9e1b]";

		return (
			<button
				type="button"
				onClick={onClick}
				className={`group relative size-3 rounded-full border transition-opacity hover:opacity-95 active:opacity-80 ${colorClasses}`}
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			>
				<span className="absolute inset-0 flex items-center justify-center text-black/70 opacity-0 transition-opacity group-hover:opacity-100">
					{icon}
				</span>
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			className={`w-12 h-9 flex items-center justify-center text-muted-foreground hover:bg-accent active:bg-accent/80 transition-colors ${
				isClose
					? "hover:!bg-red-600 hover:!text-white"
					: "hover:text-foreground"
			}`}
			style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
		>
			{icon}
		</button>
	);
}

export function TitleBar() {
	const [isMaximized, setIsMaximized] = useState(false);
	const [platform, setPlatform] = useState<string | null>(null);

	useEffect(() => {
		const api = window.electronAPI;
		if (!api) return;

		api.getPlatform().then(setPlatform);
		api.isMaximized().then(setIsMaximized);
		const unsubscribe = api.onMaximizeChange(setIsMaximized);
		return () => unsubscribe();
	}, []);

	if (!platform) {
		return null;
	}

	const isMac = platform === "darwin";

	const handleDoubleClick = () => {
		// The IPC "window:maximize" handler toggles between maximize/unmaximize
		window.electronAPI?.maximize();
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: TitleBar double-click to toggle maximize
		<div
			className="relative h-9 bg-sidebar border-b border-border select-none shrink-0"
			style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
			onDoubleClick={handleDoubleClick}
		>
			<div
				className="absolute left-0 top-0 h-full flex items-center px-2"
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			>
				<SidebarTrigger />
			</div>

			<div
				className={`absolute right-0 top-0 h-full flex items-center gap-2 ${isMac ? "px-2" : "pl-2"}`}
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			>
				<ThemeToggle className="mr-1 text-muted-foreground hover:text-foreground" />
				{isMac ? (
					<div className="flex items-center gap-2">
						<WindowButton
							icon={<Plus className="size-2" strokeWidth={2.75} />}
							onClick={() => window.electronAPI?.maximize()}
							kind="mac"
							macTone="maximize"
						/>
						<WindowButton
							icon={<Minus className="size-2" strokeWidth={2.75} />}
							onClick={() => window.electronAPI?.minimize()}
							kind="mac"
							macTone="minimize"
						/>
						<WindowButton
							icon={<X className="size-2" strokeWidth={2.75} />}
							onClick={() => window.electronAPI?.close()}
							isClose
							kind="mac"
							macTone="close"
						/>
					</div>
				) : (
					<div className="flex items-center">
						<WindowButton
							icon={<Minus className="size-4" />}
							onClick={() => window.electronAPI?.minimize()}
						/>
						<WindowButton
							icon={
								isMaximized ? (
									<Minimize className="size-4" />
								) : (
									<Square className="size-4" />
								)
							}
							onClick={() => window.electronAPI?.maximize()}
						/>
						<WindowButton
							icon={<X className="size-4" />}
							onClick={() => window.electronAPI?.close()}
							isClose
						/>
					</div>
				)}
			</div>
		</div>
	);
}
