"use client";

import { useEffect, useState } from "react";

import { AVATARS, Avatar } from "./avatar";
import { useLumi } from "./lumi-provider";
import { Modal } from "./ui";

/** Thêm hoặc sửa trợ lý: tên, avatar, vai trò/chuyên môn, mô tả, dự án tham gia, quyền PM. */
export function MemberFormModal() {
  const { state, memberForm, closeMemberForm, dispatch, toast } = useLumi();
  const { open, editId, presetProjectId } = memberForm;
  const editing = editId ? state.members.find((m) => m.id === editId) : undefined;
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState("bot");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [permission, setPermission] = useState<"assistant" | "pm">("assistant");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    if (editing) {
      setName(editing.name);
      setAvatar(editing.avatar);
      setRole(editing.role);
      setDescription(editing.description);
      setProjectIds(editing.projectIds);
      setPermission(editing.permission === "pm" ? "pm" : "assistant");
    } else {
      setName("");
      setAvatar("bot");
      setRole("");
      setDescription("");
      setProjectIds(presetProjectId ? [presetProjectId] : []);
      setPermission("assistant");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  const isHuman = editing?.kind === "human";
  const toggle = (id: string) => setProjectIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const r = editing
      ? await dispatch({ type: "member.update", id: editing.id, name, avatar, role, description, ...(isHuman ? {} : { projectIds, permission }) })
      : await dispatch({ type: "member.create", name, avatar, role, description, projectIds, permission });
    setBusy(false);
    if (r.ok) {
      toast(editing ? `Đã lưu hồ sơ ${name}.` : `Đã tạo ${name}. Hồ sơ đã tạo, chưa kết nối Hermes.`);
      closeMemberForm();
    }
  }

  return (
    <Modal open={open} onClose={closeMemberForm} title={editing ? `Sửa hồ sơ: ${editing.name}` : "Thêm trợ lý"} wide>
      <form onSubmit={submit}>
        <label className="l-label" htmlFor="mf-name">Tên</label>
        <input id="mf-name" className="l-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required placeholder="Ví dụ: Trợ lý PM" />
        <div className="l-label">Avatar</div>
        <div className="l-row" role="radiogroup" aria-label="Chọn avatar">
          {AVATARS.map((a) => (
            <button
              type="button"
              key={a.key}
              role="radio"
              aria-checked={avatar === a.key}
              aria-label={a.label}
              title={a.label}
              onClick={() => setAvatar(a.key)}
              className="l-btn ghost"
              style={{ padding: 4, minHeight: 0, borderColor: avatar === a.key ? "var(--l-accent)" : undefined, boxShadow: avatar === a.key ? "0 0 0 1px var(--l-accent)" : undefined }}
            >
              <Avatar avatar={a.key} size={34} />
            </button>
          ))}
        </div>
        <label className="l-label" htmlFor="mf-role">Vai trò / chuyên môn</label>
        <input id="mf-role" className="l-input" value={role} onChange={(e) => setRole(e.target.value)} placeholder="Ví dụ: Điều phối dự án" />
        <label className="l-label" htmlFor="mf-desc">Mô tả</label>
        <textarea id="mf-desc" className="l-textarea" value={description} onChange={(e) => setDescription(e.target.value)} />
        {!isHuman && (
          <>
            <div className="l-label">Dự án tham gia</div>
            <div className="l-row">
              {state.projects.filter((p) => p.status === "active").map((p) => (
                <label key={p.id} className="l-badge" style={{ cursor: "pointer", padding: "5px 11px" }}>
                  <input type="checkbox" checked={projectIds.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name}
                </label>
              ))}
            </div>
            <label className="l-label" htmlFor="mf-perm">Quyền được giao</label>
            <select id="mf-perm" className="l-select" value={permission} onChange={(e) => setPermission(e.target.value as "assistant" | "pm")}>
              <option value="assistant">Trợ lý thường (nhận việc)</option>
              <option value="pm">Trợ lý PM (nhận việc và có thể làm PM của dự án)</option>
            </select>
          </>
        )}
        <p className="small muted" style={{ marginTop: 10 }}>
          Ba trạng thái tách riêng: <strong>đã tạo hồ sơ</strong> (ngay khi lưu), <strong>đã kết nối Hermes</strong> (bật trong hồ sơ, mô phỏng) và <strong>đang thực thi</strong> (khi có việc đang làm).
        </p>
        <div className="l-row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
          <button type="button" className="l-btn" onClick={closeMemberForm}>Hủy</button>
          <button type="submit" className="l-btn primary" disabled={busy || !name.trim()}>{editing ? "Lưu" : "Tạo trợ lý"}</button>
        </div>
      </form>
    </Modal>
  );
}
