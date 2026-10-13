import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { randomUUID } from "../../lib/utils";
import { classifyComposerAttachmentFile } from "../chat/composerAttachmentFiles";

export type PendingUpload = ComposerImageAttachment | ComposerFileAttachment;

/** Starts T3's signed uploads for picked files, the same queue the chat composer uses. */
export function startUploads(
  environmentId: EnvironmentId,
  files: ReadonlyArray<File>,
): PendingUpload[] {
  return files.map((file) => {
    const base = {
      id: randomUUID(),
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    };
    const upload: PendingUpload =
      classifyComposerAttachmentFile(file) === "image"
        ? { ...base, type: "image", previewUrl: URL.createObjectURL(file), file }
        : { ...base, type: "file", file };
    startAttachmentUpload({ environmentId, image: upload });
    return upload;
  });
}

/** Waits for the uploads; `null` when any failed. */
export async function finishUploads(
  environmentId: EnvironmentId,
  uploads: ReadonlyArray<PendingUpload>,
): Promise<ChatAttachment[] | null> {
  await awaitAttachmentUploads(uploads.map((upload) => upload.id));
  return getUploadedAttachments({ environmentId, images: uploads });
}

/** Discards uploads that were never sent. */
export function releaseUploads(uploads: ReadonlyArray<PendingUpload>): void {
  for (const upload of uploads) {
    releaseAttachmentUpload(upload.id);
    if (upload.type === "image") URL.revokeObjectURL(upload.previewUrl);
  }
}
