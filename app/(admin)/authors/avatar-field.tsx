"use client";

import { useState } from "react";
import { MediaPicker } from "@/components/media/media-picker";

export function AvatarField({ current }: { current: string | null }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<{ id: string; src: string | null } | null>(null);
  const src = picked?.src ?? current;
  return (
    <div className="flex items-center gap-3 text-sm">
      {src ? <img src={src} alt="" className="size-12 rounded-full object-cover" /> : <span className="flex size-12 items-center justify-center rounded-full bg-sage text-muted">—</span>}
      <input type="hidden" name="avatarMediaId" value={picked?.id ?? ""} />
      <button type="button" onClick={() => setOpen(true)} className="min-h-11 rounded-md border border-rule px-3 hover:bg-sage">{src ? "Change portrait" : "Add portrait"}</button>
      <MediaPicker open={open} title="Choose a portrait" onClose={() => setOpen(false)} onSelect={(m) => { setPicked({ id: m.id, src: m.preview?.src ?? null }); setOpen(false); }} />
    </div>
  );
}
