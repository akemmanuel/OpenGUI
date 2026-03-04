/**
 * Shared back-button + title header used by provider sub-dialogs.
 */

import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

interface SubDialogHeaderProps {
	onBack: () => void;
	/** Title text or custom content shown after the back button. */
	children: ReactNode;
}

export function SubDialogHeader({ onBack, children }: SubDialogHeaderProps) {
	return (
		<div className="flex items-center gap-3">
			<button
				type="button"
				onClick={onBack}
				className="text-muted-foreground hover:text-foreground transition-colors"
			>
				<ArrowLeft className="size-4" />
			</button>
			{children}
		</div>
	);
}
