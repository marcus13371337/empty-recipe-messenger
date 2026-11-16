import type { JobContext, JsonValue } from "@empty/module-sdk";
import { listOf, numberOf, objectOf, reasonOf, textOf } from "./json";
import {
  ACCOUNT,
  CONNECTION,
  keptListing,
  keptMessage,
  type Listed,
  type Message,
} from "./messenger";

const KEPT_DAYS = 30;
const OVERLAP_MS = 5 * 60_000;
const SKIPPED_OUTAGES = ["asleep", "timeout"];

const isHere = async (context: JobContext) =>
  (await context.connectors.list()).some(({ name }) => name === CONNECTION);

function unique<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

const messagesIn = (value: JsonValue | undefined) =>
  listOf(value).flatMap((entry) => keptMessage(entry) ?? []);

const listingsIn = (value: JsonValue | undefined) =>
  listOf(value).flatMap((entry) => keptListing(entry) ?? []);

async function freshMessages(context: JobContext, listed: Listed[], after: number) {
  const found: Message[] = [];
  for (const { conversation, encrypted, last_activity_at } of listed) {
    if (encrypted || !(Date.parse(last_activity_at) > after)) continue;
    const answer = objectOf(
      await context.connectors.call(CONNECTION, "since", {
        conversation: conversation.id,
        after: new Date(after).toISOString(),
      }),
    );
    found.push(...messagesIn(answer.messages));
  }
  return found;
}

async function lastLines(context: JobContext, account: string | undefined) {
  const last = new Map<string, Message>();
  if (account === undefined) return last;
  const rows = await context.collection("messages/conversations").query({ where: { account } });
  for (const { source_id, last_text, last_at, last_from_me } of rows) {
    if (!source_id || !last_at) continue;
    last.set(source_id, {
      id: `${source_id}/last`,
      conversation: source_id,
      from: null,
      from_me: last_from_me ?? false,
      text: last_text ?? null,
      sent: last_at,
      attachments: [],
      reactions: [],
    });
  }
  return last;
}

export async function syncAccount(context: JobContext, now = new Date()) {
  const source = context.module;
  const since = new Date(now.getTime() - KEPT_DAYS * 86_400_000);
  const [kept] = await context
    .collection("messages/accounts")
    .query({ where: { source, source_id: ACCOUNT.id } });
  const syncedAt = kept?.synced_at ? Date.parse(kept.synced_at) - OVERLAP_MS : since.getTime();
  try {
    const listed = listingsIn(
      objectOf(await context.connectors.call(CONNECTION, "conversations", {})).conversations,
    );
    const waiting = objectOf(await context.connectors.call(CONNECTION, "take_events", {}));
    const messages = unique([
      ...(await freshMessages(context, listed, syncedAt)),
      ...messagesIn(waiting.messages),
    ]).filter(({ sent }) => Date.parse(sent) >= since.getTime());
    const newest = await lastLines(context, kept?.id);
    for (const message of [...messages].sort((a, b) => Date.parse(a.sent) - Date.parse(b.sent))) {
      newest.set(message.conversation, message);
    }
    const conversations = unique(
      [...listed, ...listingsIn(waiting.conversations)].map(({ conversation }) => conversation),
    ).map((conversation) => {
      const last = newest.get(conversation.id);
      return last ? { ...conversation, last_message: last } : conversation;
    });
    const synced = await context.action("messages/sync", {
      source,
      account: ACCOUNT,
      since: since.toISOString(),
      conversations,
      messages,
      changed: messagesIn(waiting.changed),
    });
    await context.connectors.call(CONNECTION, "drop_events", { upTo: numberOf(waiting.upTo) ?? 0 });
    return synced;
  } catch (error) {
    const failed_because = context.connectors.failedBecause(error);
    if (!SKIPPED_OUTAGES.includes(failed_because ?? "")) {
      const state = objectOf(
        await context.connectors.call(CONNECTION, "state", {}).catch(() => null),
      );
      const problem = textOf(state.message) ?? reasonOf(error);
      await context.action("messages/syncFailed", {
        source,
        account: ACCOUNT,
        problem,
        failed_because,
      });
    }
    throw error;
  }
}

export async function sync(context: JobContext) {
  if (!(await isHere(context))) {
    await context.action("messages/forget", { source: context.module, account: ACCOUNT.id });
    return { synced: 0 };
  }
  await syncAccount(context);
  return { synced: 1 };
}

type File = { name: string; base64: string };
type Due = { id: string; conversation: string | null; text: string | null; files: File[] };

const fileIn = (value: JsonValue): File[] => {
  const name = textOf(objectOf(value).name);
  const base64 = textOf(objectOf(value).base64);
  return name === null || base64 === null ? [] : [{ name, base64 }];
};

function dueIn(answer: JsonValue): Due | null {
  const due = objectOf(answer).send;
  const id = textOf(objectOf(due).id);
  if (id === null) return null;
  const { conversation, text, files } = objectOf(due);
  return {
    id,
    conversation: textOf(conversation),
    text: textOf(text),
    files: listOf(files).flatMap(fileIn),
  };
}

export async function send(context: JobContext) {
  const source = context.module;
  let sent = 0;
  for (;;) {
    const due = dueIn(await context.action("messages/takeDue", { source }));
    if (!due) return { sent };
    sent += 1;
    try {
      if (due.conversation === null) {
        throw new Error("Messenger can only answer in a chat that is already there.");
      }
      const { conversation } = due;
      await context.onBehalfOf("messages/messages", due, () =>
        context.connectors.call(CONNECTION, "send", {
          conversation,
          ...(due.text !== null && { text: due.text }),
          ...(due.files.length > 0 && { files: due.files }),
        }),
      );
    } catch (error) {
      await context.action("messages/sent", { source, id: due.id, problem: reasonOf(error) });
      continue;
    }
    await syncAccount(context).catch(() => null);
    await context.action("messages/sent", { source, id: due.id });
  }
}
