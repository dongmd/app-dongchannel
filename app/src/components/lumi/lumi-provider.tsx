"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Action, Result } from "@/lib/lumi/engine";
import type { DemoState, Member } from "@/lib/lumi/types";

interface NewTaskPreset {
  projectId?: string;
  ownerId?: string;
  title?: string;
}
interface MemberFormState {
  open: boolean;
  editId?: string;
  presetProjectId?: string;
}

interface Ctx {
  state: DemoState;
  dispatch: (a: Action) => Promise<Result>;
  reset: () => Promise<void>;
  toast: (msg: string) => void;
  newTask: { open: boolean; preset: NewTaskPreset };
  openNewTask: (preset?: NewTaskPreset) => void;
  closeNewTask: () => void;
  memberForm: MemberFormState;
  openMemberForm: (s?: Omit<MemberFormState, "open">) => void;
  closeMemberForm: () => void;
  navOpen: boolean;
  setNavOpen: (v: boolean) => void;
  /** DSH-08: when the state was last fetched successfully and whether the last fetch failed (numbers may then be stale). */
  sync: { lastOkAt: number; failing: boolean };
}

const LumiContext = createContext<Ctx | null>(null);

export function useLumi(): Ctx {
  const c = useContext(LumiContext);
  if (!c) throw new Error("useLumi phải nằm trong LumiProvider");
  return c;
}

export function LumiProvider({ initial, children }: { initial: DemoState; children: ReactNode }) {
  const [state, setState] = useState<DemoState>(initial);
  const revRef = useRef(initial.rev);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const [newTask, setNewTask] = useState<Ctx["newTask"]>({ open: false, preset: {} });
  const [memberForm, setMemberForm] = useState<MemberFormState>({ open: false });
  const [navOpen, setNavOpen] = useState(false);
  const [sync, setSync] = useState({ lastOkAt: Date.now(), failing: false });

  const apply = useCallback((s: DemoState) => {
    revRef.current = s.rev;
    setState(s);
  }, []);

  const toast = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  // Web và Telegram mô phỏng dùng chung một kho: kéo trạng thái mới 2 giây một lần (khi tab đang hiện).
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (stop || document.visibilityState !== "visible") return;
      try {
        const res = await fetch("/api/lumi/state", { cache: "no-store" });
        if (!res.ok) { setSync((x) => ({ ...x, failing: true })); return; }
        const s = (await res.json()) as DemoState;
        setSync({ lastOkAt: Date.now(), failing: false });
        if (s.rev !== revRef.current) apply(s);
      } catch {
        setSync((x) => ({ ...x, failing: true })); // mất kết nối tạm thời: giữ số cũ nhưng BÁO là cũ; lần sau thử lại
      }
    };
    const id = setInterval(poll, 2000);
    const onVis = () => void poll();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [apply]);

  const dispatch = useCallback(
    async (action: Action): Promise<Result> => {
      try {
        const res = await fetch("/api/lumi/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = (await res.json()) as { result: Result; state?: DemoState };
        if (data.state) apply(data.state);
        if (!data.result.ok) toast(data.result.message ?? "Không thực hiện được.");
        else if (data.result.code === "already") toast(data.result.message ?? "Đã xử lý trước đó, không tạo trùng.");
        return data.result;
      } catch {
        toast("Mất kết nối tới máy chủ preview.");
        return { ok: false, code: "invalid", message: "Mất kết nối" };
      }
    },
    [apply, toast],
  );

  const reset = useCallback(async () => {
    const res = await fetch("/api/lumi/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset: true }),
    });
    const data = (await res.json()) as { state?: DemoState };
    if (data.state) apply(data.state);
    toast("Đã đặt lại dữ liệu demo.");
  }, [apply, toast]);

  const value = useMemo<Ctx>(
    () => ({
      state,
      dispatch,
      reset,
      toast,
      newTask,
      openNewTask: (preset = {}) => setNewTask({ open: true, preset }),
      closeNewTask: () => setNewTask({ open: false, preset: {} }),
      memberForm,
      openMemberForm: (s = {}) => setMemberForm({ open: true, ...s }),
      closeMemberForm: () => setMemberForm({ open: false }),
      navOpen,
      setNavOpen,
      sync,
    }),
    [state, dispatch, reset, toast, newTask, memberForm, navOpen, sync],
  );

  return (
    <LumiContext.Provider value={value}>
      {children}
      <div className="l-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="l-toast">
            {t.msg}
          </div>
        ))}
      </div>
    </LumiContext.Provider>
  );
}

export type { Member };
