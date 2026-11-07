"use client";

import {
  Bot,
  Brain,
  Clapperboard,
  Compass,
  Crown,
  Lightbulb,
  Megaphone,
  PenTool,
  Rocket,
  Search,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export interface AvatarDef {
  key: string;
  label: string;
  color: string;
  Icon: LucideIcon;
}

// Bộ avatar dùng chung cho 2D, 3D, danh sách và form. Màu + biểu tượng nhận diện được.
export const AVATARS: AvatarDef[] = [
  { key: "crown", label: "Vương miện", color: "#f5b84a", Icon: Crown },
  { key: "compass", label: "La bàn", color: "#78adff", Icon: Compass },
  { key: "clapper", label: "Máy quay", color: "#f07474", Icon: Clapperboard },
  { key: "shield", label: "Khiên", color: "#52c98f", Icon: ShieldCheck },
  { key: "rocket", label: "Tên lửa", color: "#b095ff", Icon: Rocket },
  { key: "brain", label: "Bộ não", color: "#f59ac2", Icon: Brain },
  { key: "bot", label: "Robot", color: "#6fd6e8", Icon: Bot },
  { key: "bulb", label: "Bóng đèn", color: "#e8d36f", Icon: Lightbulb },
  { key: "pen", label: "Bút", color: "#ff9d6e", Icon: PenTool },
  { key: "search", label: "Tìm kiếm", color: "#9ad66f", Icon: Search },
  { key: "mega", label: "Loa", color: "#d98cf0", Icon: Megaphone },
  { key: "spark", label: "Tia sáng", color: "#8fb4ff", Icon: Sparkles },
];

export const avatarOf = (key: string): AvatarDef => AVATARS.find((a) => a.key === key) ?? AVATARS[6]!;

export function Avatar({ avatar, size = 36, square = false, label }: { avatar: string; size?: number; square?: boolean; label?: string }) {
  const a = avatarOf(avatar);
  const Icon = a.Icon;
  return (
    <span
      className={`l-avatar${square ? " sq" : ""}`}
      style={{ width: size, height: size, background: `linear-gradient(145deg, ${a.color}, ${a.color}bb)` }}
      role="img"
      aria-label={label ?? `Avatar ${a.label}`}
      data-avatar={a.key}
    >
      <Icon size={Math.round(size * 0.55)} strokeWidth={2.2} aria-hidden />
    </span>
  );
}
