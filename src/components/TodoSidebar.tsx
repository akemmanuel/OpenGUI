/**
 * Right sidebar panel that displays the current session's todo list grouped
 * by status (In Progress, Pending, Completed, Cancelled).
 *
 * Uses the standard shadcn Sidebar primitives inside a RightSidebarProvider
 * so the UI is consistent with the left sidebar.
 */

import { Circle, ListTodo } from "lucide-react";
import { useMemo } from "react";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuItem,
	SidebarRail,
} from "@/components/ui/sidebar";
import { STATUS_ORDER, type TodoItem, todoStatusConfig } from "@/lib/todos";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Grouped todos helper
// ---------------------------------------------------------------------------

interface TodoGroup {
	status: string;
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	color: string;
	items: TodoItem[];
}

function useTodoGroups(todos: TodoItem[] | null): TodoGroup[] {
	return useMemo(() => {
		if (!todos || todos.length === 0) return [];

		const byStatus = new Map<string, TodoItem[]>();
		for (const todo of todos) {
			const existing = byStatus.get(todo.status);
			if (existing) {
				existing.push(todo);
			} else {
				byStatus.set(todo.status, [todo]);
			}
		}

		const groups: TodoGroup[] = [];
		for (const status of STATUS_ORDER) {
			const items = byStatus.get(status);
			if (!items || items.length === 0) continue;
			const cfg = todoStatusConfig[status];
			if (!cfg) continue;
			groups.push({
				status,
				label: cfg.label,
				icon: cfg.icon,
				color: cfg.color,
				items,
			});
		}

		// Include any unknown statuses at the end
		for (const [status, items] of byStatus) {
			if (STATUS_ORDER.includes(status as (typeof STATUS_ORDER)[number]))
				continue;
			const cfg = todoStatusConfig[status] ??
				todoStatusConfig.pending ?? {
					icon: Circle,
					color: "text-muted-foreground",
					label: status,
				};
			groups.push({
				status,
				label: status,
				icon: cfg.icon,
				color: cfg.color,
				items,
			});
		}

		return groups;
	}, [todos]);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TodoSidebar({ todos }: { todos: TodoItem[] | null }) {
	const groups = useTodoGroups(todos);

	const completedCount = useMemo(
		() => todos?.filter((t) => t.status === "completed").length ?? 0,
		[todos],
	);
	const totalCount = todos?.length ?? 0;

	return (
		<Sidebar
			side="right"
			collapsible="offcanvas"
			className="top-9 h-[calc(100svh-2.25rem)]"
		>
			{/* Header */}
			<SidebarHeader className="border-b border-border/40">
				<div className="flex items-center justify-between px-1">
					<div className="flex items-center gap-2">
						<ListTodo className="size-4 text-muted-foreground" />
						<span className="text-sm font-medium">Tasks</span>
					</div>
					{totalCount > 0 && (
						<span className="text-xs text-muted-foreground tabular-nums">
							{completedCount}/{totalCount}
						</span>
					)}
				</div>
				{/* Progress bar */}
				{totalCount > 0 && (
					<div className="mx-1 h-1 rounded-full bg-muted overflow-hidden">
						<div
							className="h-full rounded-full bg-emerald-500 transition-all duration-300"
							style={{
								width: `${Math.round((completedCount / totalCount) * 100)}%`,
							}}
						/>
					</div>
				)}
			</SidebarHeader>

			{/* Content */}
			<SidebarContent>
				{groups.length === 0 ? (
					<div className="flex flex-col items-center justify-center py-8 px-4 text-center">
						<ListTodo className="size-8 text-muted-foreground/30 mb-2" />
						<p className="text-xs text-muted-foreground">No tasks yet</p>
					</div>
				) : (
					groups.map((group) => {
						const GroupIcon = group.icon;
						return (
							<SidebarGroup key={group.status}>
								<SidebarGroupLabel className="gap-1.5">
									<GroupIcon className={cn("size-3.5 shrink-0", group.color)} />
									<span>{group.label}</span>
									<span className="ml-auto text-[10px] tabular-nums opacity-60">
										{group.items.length}
									</span>
								</SidebarGroupLabel>
								<SidebarGroupContent>
									<SidebarMenu>
										{group.items.map((todo, i) => (
											<SidebarMenuItem
												key={`${group.status}-${todo.content}-${i}`}
											>
												<div
													className={cn(
														"flex items-start gap-2 px-2 py-1 text-xs leading-snug rounded-md",
														todo.status === "cancelled" &&
															"line-through opacity-50",
														todo.status === "completed" &&
															"text-muted-foreground",
													)}
												>
													<GroupIcon
														className={cn(
															"size-3 shrink-0 mt-0.5",
															group.color,
														)}
													/>
													<span className="break-words min-w-0">
														{todo.content}
													</span>
												</div>
											</SidebarMenuItem>
										))}
									</SidebarMenu>
								</SidebarGroupContent>
							</SidebarGroup>
						);
					})
				)}
			</SidebarContent>

			<SidebarRail />
		</Sidebar>
	);
}
