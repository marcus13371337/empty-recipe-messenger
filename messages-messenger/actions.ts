import type { ActionArgs, JobContext } from "@empty/module-sdk";
import { listOf, objectOf, textOf } from "./json";
import { CONNECTOR, keptAttachments, keptMessage } from "./messenger";

export async function older(
  context: JobContext,
  { conversation, before, limit }: ActionArgs<"messages-messenger/older">,
) {
  const answer = objectOf(
    await context.connectors.call(CONNECTOR, "earlier", { conversation, before, limit }),
  );
  return { messages: listOf(answer.messages).flatMap((entry) => keptMessage(entry) ?? []) };
}

export async function search() {
  return { messages: [] };
}

export async function attachment(
  context: JobContext,
  { id }: ActionArgs<"messages-messenger/attachment">,
) {
  const answer = objectOf(await context.connectors.call(CONNECTOR, "attachment", { id }));
  const file = objectOf(answer.file);
  return {
    attachment: keptAttachments([answer.attachment ?? null])[0] ?? { id },
    file: {
      base64: textOf(file.base64) ?? "",
      media_type: textOf(file.media_type) ?? "application/octet-stream",
    },
    kept: "here" as const,
  };
}

export async function openAttachment(context: JobContext): Promise<never> {
  throw context.sources.refusal("cannot_do_here");
}

export async function showAttachment(context: JobContext): Promise<never> {
  throw context.sources.refusal("cannot_do_here");
}

export async function openConversation(
  context: Pick<JobContext, "openLink">,
  { conversation }: ActionArgs<"messages-messenger/openConversation">,
) {
  await context.openLink(`https://www.facebook.com/messages/t/${encodeURIComponent(conversation)}`);
  return { opened: true };
}
