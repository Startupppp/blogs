"use client";

import { useActionState } from "react";
import type { ActionResult } from "@/lib/server/action";

interface Props {
  action: (formData: FormData) => Promise<ActionResult<unknown>>;
  children: React.ReactNode;
  submitLabel: string;
  className?: string;
  confirmMessage?: string;
  tone?: "primary" | "quiet" | "danger";
}

const TONES = {
  primary: "bg-ink text-paper hover:opacity-90",
  quiet: "border border-rule hover:bg-sage",
  danger: "text-danger hover:bg-danger-soft",
};

/** A form bound to a server action, with inline errors and a live status message. */
export function ActionForm({ action, children, submitLabel, className, confirmMessage, tone = "primary" }: Props) {
  const [state, formAction, pending] = useActionState(async (_prev: ActionResult<unknown> | null, formData: FormData) => action(formData), null);
  return (
    <form action={formAction} className={className}
      onSubmit={(e) => { if (confirmMessage && !confirm(confirmMessage)) e.preventDefault(); }}>
      {children}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={`min-h-11 rounded-md px-4 text-sm font-medium disabled:opacity-50 ${TONES[tone]}`}>
          {pending ? "Working…" : submitLabel}
        </button>
        <span aria-live="polite" className="text-sm">
          {state && !state.ok ? (
            <span role="alert" className="text-danger">{[state.message, ...Object.values(state.fields)].join(" ")}</span>
          ) : state?.ok ? <span className="text-ok">Done.</span> : null}
        </span>
      </div>
    </form>
  );
}

export const inputClass = "min-h-11 w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm";
export const labelClass = "flex flex-col gap-1.5 text-sm font-medium";
