"use client";

import { ActionForm, inputClass, labelClass } from "@/components/ui/action-form";
import type { MediaSummary } from "@/lib/server/blog/queries";
import { deleteMediaAction, removeFromDeliveryAction, updateMediaAction } from "./actions";

export function MediaItemForms({ item, canManage }: { item: MediaSummary; canManage: boolean }) {
  return (
    <div className="space-y-3">
      <ActionForm submitLabel="Save details" tone="quiet" className="space-y-3" action={(fd) => updateMediaAction({
        mediaId: item.id,
        altDefault: String(fd.get("altDefault") ?? "") || null,
        credit: String(fd.get("credit") ?? "") || null,
        sourceUrl: String(fd.get("sourceUrl") ?? "") || null,
        license: String(fd.get("license") ?? "") || null,
        focalX: Number(fd.get("focalX")) / 100,
        focalY: Number(fd.get("focalY")) / 100,
      })}>
        <label className={labelClass}>Default alt text<input name="altDefault" maxLength={300} defaultValue={item.altDefault ?? ""} className={inputClass} /></label>
        <label className={labelClass}>Credit<input name="credit" maxLength={300} defaultValue={item.credit ?? ""} placeholder="Photographer / source" className={inputClass} /></label>
        <label className={labelClass}>Source URL<input name="sourceUrl" type="url" maxLength={1000} defaultValue={item.sourceUrl ?? ""} className={inputClass} /></label>
        <label className={labelClass}>Licence<input name="license" maxLength={300} defaultValue={item.license ?? ""} placeholder="e.g. Licensed from …, internal" className={inputClass} /></label>
        <fieldset disabled={item.promoted} className="grid grid-cols-2 gap-3">
          <legend className="text-sm font-medium">Social crop focus {item.promoted ? "(locked once published)" : ""}</legend>
          <label className={labelClass}>Horizontal %<input name="focalX" type="number" min={0} max={100} defaultValue={Math.round(item.focalX * 100)} className={inputClass} /></label>
          <label className={labelClass}>Vertical %<input name="focalY" type="number" min={0} max={100} defaultValue={Math.round(item.focalY * 100)} className={inputClass} /></label>
        </fieldset>
      </ActionForm>
      <div className="flex flex-wrap gap-2">
        <ActionForm action={() => deleteMediaAction(item.id)} submitLabel="Delete" tone="danger" confirmMessage="Delete this image? It must not be used in any post.">
          <span />
        </ActionForm>
        {canManage && item.promoted ? (
          <ActionForm action={() => removeFromDeliveryAction(item.id)} submitLabel="Remove public copies" tone="danger"
            confirmMessage="Remove this image's public files? Only allowed when no live post uses it. CDN caches may keep copies until purged.">
            <span />
          </ActionForm>
        ) : null}
      </div>
    </div>
  );
}
