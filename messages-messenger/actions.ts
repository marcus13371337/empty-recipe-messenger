import type { ActionArgs, JobContext } from "@empty/module-sdk";
import { listOf, objectOf } from "./json";
import { CONNECTION } from "./messenger";

export async function older(
  context: JobContext,
  { conversation, before, limit }: ActionArgs<"messages-messenger/older">,
) {
  const answer = objectOf(
    await context.connectors.call(CONNECTION, "earlier", { conversation, before, limit }),
  );
  return { messages: listOf(answer.messages) };
}

export async function search() {
  return { messages: [] };
}

export async function attachment(
  context: JobContext,
  { id }: ActionArgs<"messages-messenger/attachment">,
) {
  return context.connectors.call(CONNECTION, "attachment", { id });
}

const ONLY_IN_MESSENGER = "Messenger files open in Messenger: open the chat there.";

export async function openAttachment(): Promise<never> {
  throw new Error(ONLY_IN_MESSENGER);
}

export async function showAttachment(): Promise<never> {
  throw new Error(ONLY_IN_MESSENGER);
}

export async function openConversation(
  context: JobContext,
  { conversation }: ActionArgs<"messages-messenger/openConversation">,
) {
  await context.openLink(`https://www.messenger.com/t/${encodeURIComponent(conversation)}`);
  return { opened: true };
}
