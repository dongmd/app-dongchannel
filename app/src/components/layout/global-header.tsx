"use client";

import { UserMenu } from "@/components/user-menu";
import { ProfileSwitcher } from "./profile-switcher";
import { HeaderStatusIndicator } from "./header-status-indicator";
import { HeaderSearch } from "./header-search";
import { NotificationsBell } from "./notifications-bell";

// AC02 — global header với search + profile switcher + +Task + notif + user menu.
// Search = DC-013. Notif = DC-015. (+Task removed at P3-R08 AC-06.)
export function GlobalHeader() {
  return (
    <header
      role="banner"
      className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur md:px-6"
    >
      {/* Chừa chỗ mobile menu toggle */}
      <div className="w-10 md:hidden" aria-hidden="true" />

      {/* Profile switcher — hiện cả mobile & desktop */}
      <ProfileSwitcher />

      {/* Search — DC-013 */}
      <HeaderSearch />

      {/* P3-R08 AC-06 -- the `+ Tạo nhiệm vụ` control was REMOVED, 2026-08-22.
          It was hard-disabled with an aria-label promising DC-005, which had
          already shipped, so it was a permanently inert control in a header
          whose criterion requires each element to be REACHABLE, not merely
          rendered.

          It is not restored as a working button because this system does not
          create tasks: they are projected from Hermes (`tasks.source_hermes_*`),
          and there is no POST /api/v1/tasks to point it at. Building one to
          satisfy a header criterion would be inventing a feature to justify a
          button. It is not one of the five §7.2/§7.3 elements AC-06 names --
          search, notifications, profile switcher, status indicator, user menu --
          all of which are present and reachable. */}

      {/* Notification — DC-015 */}
      <NotificationsBell />

      {/* Hermes compact status — click mở /admin */}
      <HeaderStatusIndicator />

      <UserMenu />
    </header>
  );
}
