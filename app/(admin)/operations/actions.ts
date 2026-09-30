"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { editorAction } from "@/lib/server/action";
import { db } from "@/lib/server/db/client";
import { retryDeadJob } from "@/lib/server/jobs/queue";
import { runJobs } from "@/lib/server/jobs/runner";

export async function retryJobAction(fd: FormData) {
  const result = await editorAction("post:publish", async () => {
    const id = z.string().uuid().parse(fd.get("jobId"));
    await retryDeadJob(db(), id);
    await runJobs(db(), { onlyIds: [id], budgetMs: 10_000, maxJobs: 1 });
  });
  revalidatePath("/operations");
  return result;
}

export async function runQueueAction() {
  const result = await editorAction("post:publish", () => runJobs(db(), { budgetMs: 20_000, maxJobs: 20 }).then((r) => ({ processed: r.processed })));
  revalidatePath("/operations");
  return result;
}
