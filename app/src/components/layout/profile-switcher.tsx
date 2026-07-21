"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Lock } from "lucide-react";
import {
  PROFILE_FILTER_VALUES,
  PROFILE_LABELS,
  type ProfileFilter,
} from "@/lib/profiles/types";
import { useProfileFilter } from "@/lib/profiles/client";
import { cn } from "@/lib/utils";

// AC01/AC03/AC07 — dropdown 3 option, active highlight, ARIA menu + keyboard nav.
// Pattern: focus di chuyển vào menu container khi mở, aria-activedescendant trỏ item highlight.
export function ProfileSwitcher() {
  const { current, forced, setFilter } = useProfileFilter();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // ESC + click ngoài để đóng
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const handleClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    window.addEventListener("mousedown", handleClick);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("mousedown", handleClick);
    };
  }, [open]);

  // Khi menu mở: focus vào container để Arrow/Enter reach handleMenuKey.
  useLayoutEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  const currentLabel = PROFILE_LABELS[current];
  const isForced = forced !== null;

  const handleSelect = (value: ProfileFilter) => {
    setFilter(value);
    setOpen(false);
    buttonRef.current?.focus();
  };

  const handleMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % PROFILE_FILTER_VALUES.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? PROFILE_FILTER_VALUES.length - 1 : i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const value = PROFILE_FILTER_VALUES[activeIndex];
      if (value) handleSelect(value);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(PROFILE_FILTER_VALUES.length - 1);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (isForced) return;
          setOpen((v) => !v);
          setActiveIndex(PROFILE_FILTER_VALUES.indexOf(current));
        }}
        onKeyDown={(e) => {
          if (isForced) return;
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
            setActiveIndex(PROFILE_FILTER_VALUES.indexOf(current));
          }
        }}
        disabled={isForced}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="profile-switcher-menu"
        aria-label={
          isForced
            ? `Profile khoá cố định: ${currentLabel.long}`
            : `Chọn profile — đang chọn ${currentLabel.long}`
        }
        title={isForced ? "Trang này khoá theo profile" : undefined}
        className={cn(
          "flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
          isForced
            ? "cursor-not-allowed bg-muted/30 text-muted-foreground"
            : "hover:bg-accent",
        )}
      >
        {isForced ? (
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="font-medium">{currentLabel.short}</span>
      </button>

      {open && !isForced ? (
        <div
          id="profile-switcher-menu"
          ref={menuRef}
          role="menu"
          aria-label="Chọn profile"
          aria-activedescendant={`profile-opt-${PROFILE_FILTER_VALUES[activeIndex]}`}
          onKeyDown={handleMenuKey}
          tabIndex={-1}
          className="absolute left-0 top-full z-40 mt-1 w-52 overflow-hidden rounded-md border border-border bg-background shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {PROFILE_FILTER_VALUES.map((value, idx) => {
            const label = PROFILE_LABELS[value];
            const active = value === current;
            const focused = idx === activeIndex;
            return (
              <button
                key={value}
                id={`profile-opt-${value}`}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => handleSelect(value)}
                onMouseEnter={() => setActiveIndex(idx)}
                tabIndex={-1}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors",
                  focused ? "bg-accent" : "bg-transparent",
                  active ? "text-primary" : "text-foreground",
                )}
              >
                <span>
                  <span className="block leading-tight">{label.short}</span>
                  <span className="block text-xs text-muted-foreground">{label.long}</span>
                </span>
                {active ? <Check className="h-4 w-4" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
