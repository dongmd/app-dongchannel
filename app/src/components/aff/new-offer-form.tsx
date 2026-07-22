"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

const COMMISSION_TYPES = ["UNKNOWN", "CPA", "REVSHARE", "RECURRING", "HYBRID"] as const;
const COMMISSION_UNITS = ["percent", "usd", "usd_recurring"] as const;

export function NewOfferForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const commissionValueRaw = fd.get("commissionValue")?.toString().trim();
    const cookieDaysRaw = fd.get("cookieDays")?.toString().trim();
    const countriesRaw = fd.get("countries")?.toString().trim();

    const payload = {
      name: fd.get("name")?.toString().trim() ?? "",
      websiteUrl: fd.get("websiteUrl")?.toString().trim() || null,
      network: fd.get("network")?.toString().trim() || null,
      commissionType: (fd.get("commissionType")?.toString() ?? "UNKNOWN") as (typeof COMMISSION_TYPES)[number],
      commissionValue: commissionValueRaw ? Number(commissionValueRaw) : null,
      commissionUnit: fd.get("commissionUnit")?.toString() || null,
      cookieDays: cookieDaysRaw ? Number(cookieDaysRaw) : null,
      countries: countriesRaw
        ? countriesRaw
            .split(",")
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean)
        : null,
      notes: fd.get("notes")?.toString().trim() || null,
    };

    setPending(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/v1/aff/offers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as {
        data: { id: string; name: string } | null;
        error: { message: string } | null;
      };
      if (!res.ok || body.error) {
        setMsg({ type: "error", text: body.error?.message ?? `HTTP ${res.status}` });
        return;
      }
      if (body.data?.id) {
        router.push(`/aff/offers/${body.data.id}`);
        router.refresh();
      } else {
        setMsg({ type: "success", text: "Đã tạo, tải lại danh sách" });
      }
    } catch (err) {
      setMsg({ type: "error", text: (err as Error).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-border bg-muted/10 p-4">
      <FormField label="Tên offer *" htmlFor="name">
        <input
          id="name"
          name="name"
          type="text"
          required
          minLength={2}
          maxLength={200}
          className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </FormField>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormField label="Website URL" htmlFor="websiteUrl">
          <input
            id="websiteUrl"
            name="websiteUrl"
            type="url"
            placeholder="https://…"
            maxLength={500}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </FormField>
        <FormField label="Network" htmlFor="network">
          <input
            id="network"
            name="network"
            type="text"
            placeholder="ShareASale, CJ, ImpactRadius…"
            maxLength={200}
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </FormField>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <FormField label="Commission type" htmlFor="commissionType">
          <select
            id="commissionType"
            name="commissionType"
            defaultValue="UNKNOWN"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {COMMISSION_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Value" htmlFor="commissionValue">
          <input
            id="commissionValue"
            name="commissionValue"
            type="number"
            step="0.01"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </FormField>
        <FormField label="Unit" htmlFor="commissionUnit">
          <select
            id="commissionUnit"
            name="commissionUnit"
            defaultValue=""
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">—</option>
            {COMMISSION_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </FormField>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormField label="Cookie (ngày)" htmlFor="cookieDays">
          <input
            id="cookieDays"
            name="cookieDays"
            type="number"
            min="0"
            max="365"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </FormField>
        <FormField label="Countries (ISO2, cách nhau dấu phẩy)" htmlFor="countries">
          <input
            id="countries"
            name="countries"
            type="text"
            placeholder="US, CA, GB"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </FormField>
      </div>

      <FormField label="Ghi chú" htmlFor="notes">
        <textarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={4000}
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </FormField>

      {msg ? (
        <div
          role="status"
          className={cn(
            "rounded-md px-3 py-2 text-xs",
            msg.type === "success" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive",
          )}
        >
          {msg.text}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {pending ? "Đang tạo…" : "Tạo offer"}
        </button>
      </div>
    </form>
  );
}

function FormField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
