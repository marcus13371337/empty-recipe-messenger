import type { ActionArgs, JobContext, JsonValue } from "@empty/module-sdk";
import { listOf, objectOf, textOf } from "./json";
import { CONNECTION } from "./messenger";

const PAGES = 10;

const sentAt = (message: JsonValue) => Date.parse(textOf(objectOf(message).sent) ?? "");

export async function older(
  context: JobContext,
  { conversation, before, limit }: ActionArgs<"messages-messenger/older">,
) {
  const found: JsonValue[] = [];
  let next: string | null = null;
  for (let page = 0; page < PAGES && found.length < limit; page += 1) {
    const answer = objectOf(
      await context.connectors.call(CONNECTION, "history", {
        conversation,
        limit: 200,
        ...(next !== null && { before: next }),
      }),
    );
    found.push(
      ...listOf(answer.messages).filter((message) => sentAt(message) < Date.parse(before)),
    );
    next = textOf(answer.next);
    if (next === null) break;
  }
  return { messages: found.sort((a, b) => sentAt(b) - sentAt(a)).slice(0, limit) };
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

export async function openAttachment() {
  return { opened: false };
}

export async function showAttachment() {
  return { shown: false };
}

export async function openConversation(
  context: JobContext,
  { conversation }: ActionArgs<"messages-messenger/openConversation">,
) {
  await context.openLink(`https://www.messenger.com/t/${encodeURIComponent(conversation)}`);
  return { opened: true };
}
