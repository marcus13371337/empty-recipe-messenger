import { type JobContext, type JobEvent, type JsonValue, job } from "@empty/module-sdk";
import { listOf, numberOf, objectOf } from "./json";
import {
  ACCOUNT,
  CONNECTOR,
  keptListing,
  keptMessage,
  type Listed,
  type Message,
} from "./messenger";

const KEPT_DAYS = 30;
const OVERLAP_MS = 5 * 60_000;

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
      await context.connectors.call(CONNECTOR, "since", {
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
      sent_at: last_at,
      attachments: [],
      reactions: [],
    });
  }
  return last;
}

async function syncAccount(context: JobContext) {
  const source = context.module;
  const since = new Date(Date.now() - KEPT_DAYS * 86_400_000);
  const [kept] = await context
    .collection("messages/accounts")
    .query({ where: { source, source_id: ACCOUNT.id } });
  const syncedAt = kept?.synced_at ? Date.parse(kept.synced_at) - OVERLAP_MS : since.getTime();
  return context.sources.syncing("messages", ACCOUNT, async () => {
    const listed = listingsIn(
      objectOf(await context.connectors.call(CONNECTOR, "conversations", {})).conversations,
    );
    const waiting = objectOf(await context.connectors.call(CONNECTOR, "take_events", {}));
    const messages = unique([
      ...(await freshMessages(context, listed, syncedAt)),
      ...messagesIn(waiting.messages),
    ]).filter(({ sent_at }) => Date.parse(sent_at) >= since.getTime());
    const newest = await lastLines(context, kept?.id);
    const oldestFirst = [...messages].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
    for (const message of oldestFirst) newest.set(message.conversation, message);
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
    await context.connectors.call(CONNECTOR, "drop_events", { upTo: numberOf(waiting.upTo) ?? 0 });
    return synced;
  });
}

const messengerConnectors = async (context: JobContext) =>
  (await context.connectors.list()).filter(({ name }) => name === CONNECTOR);

export const sync = job(
  {
    timeout: "5m",
    every: "5m",
    catchUp: true,
    when: [{ connector: CONNECTOR, on: ["changed", "added", "removed"] }],
  },
  async (context: JobContext, event?: JobEvent) => {
    const synced = await context.sources.feed("messages", {
      connectors: await messengerConnectors(context),
      event,
      run: async () => {
        await syncAccount(context);
      },
    });
    return { synced };
  },
);

export const send = job(
  { timeout: "5m", every: "1m", catchUp: true, when: [{ collection: "messages/messages" }] },
  async (context: JobContext) => {
    const sent = await context.sources.drain("messages/messages", async (due) => {
      if (!due.conversation) throw context.sources.refusal("cannot_do_here");
      await context.connectors.call(CONNECTOR, "send", {
        conversation: due.conversation,
        ...(due.text !== null && { text: due.text }),
        ...(due.files.length > 0 && { files: due.files }),
      });
      await syncAccount(context).catch((unsynced: Error) =>
        console.warn(`Sent, but the chat did not sync after it: ${unsynced.message}`),
      );
      return null;
    });
    return { sent };
  },
);
