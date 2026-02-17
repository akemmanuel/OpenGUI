import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
	className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
	const { theme, toggleTheme } = useTheme();

	return (
		<Button
			variant="ghost"
			size="icon-sm"
			onClick={toggleTheme}
			className={cn("h-7 w-7", className)}
			title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
		>
			{theme === "light" ? (
				<Sun className="size-3 transition-all" />
			) : (
				<Moon className="size-3 transition-all" />
			)}
			<span className="sr-only">Toggle theme</span>
		</Button>
	);
}
