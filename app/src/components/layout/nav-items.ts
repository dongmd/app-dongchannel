import type { Route } from "next";
import {
  BarChart3,
  Brain,
  Briefcase,
  DollarSign,
  Radar,
  Settings,
  Youtube,
  type LucideIcon,
} from "lucide-react";

// AC01 — nav theo PRD mục 7.1, mở rộng bởi P4-R11 (/moneyos, 2026-08-30).
// Thứ tự bám wireframe mục 8.1: Tổng quan → Công việc → AFF → YouTube → Trí nhớ → (separator) → Quản trị.
export interface NavItem {
  href: Route;
  label: string;
  icon: LucideIcon;
  match: (pathname: string) => boolean;
  badgeCount?: number; // reserved cho notification count (P4-R12)
  section: "business" | "admin";
}

export const NAV_ITEMS: NavItem[] = [
  {
    href: "/",
    label: "Tổng quan",
    icon: BarChart3,
    match: (p) => p === "/",
    section: "business",
  },
  {
    href: "/tasks",
    label: "Công việc",
    icon: Briefcase,
    match: (p) => p === "/tasks" || p.startsWith("/tasks/"),
    section: "business",
  },
  {
    // P4-R11. The AI Money OS surfaces: P2's eleven live tables finally have a
    // door. Placed after Công việc and before the two product workspaces --
    // it is the layer both of them draw their work from.
    href: "/moneyos",
    label: "Money OS",
    icon: Radar,
    match: (p) => p === "/moneyos" || p.startsWith("/moneyos/"),
    section: "business",
  },
  {
    href: "/aff",
    label: "AFF Research",
    icon: DollarSign,
    match: (p) => p === "/aff" || p.startsWith("/aff/"),
    section: "business",
  },
  {
    href: "/youtube",
    label: "YouTube",
    icon: Youtube,
    match: (p) => p === "/youtube" || p.startsWith("/youtube/"),
    section: "business",
  },
  {
    href: "/memory",
    label: "Trí nhớ",
    icon: Brain,
    match: (p) => p === "/memory" || p.startsWith("/memory/"),
    section: "business",
  },
  {
    href: "/admin",
    label: "Quản trị",
    icon: Settings,
    match: (p) => p === "/admin" || p.startsWith("/admin/"),
    section: "admin",
  },
];
