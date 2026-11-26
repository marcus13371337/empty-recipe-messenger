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

const OVERLAP_MS = 5 * 60_000;

function unique<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

const messagesIn = (value: JsonValue | undefined) =>
  listOf(value).flatMap((entry) => keptMessage(entry) ?? []);

const listingsIn = (value: JsonValue | undefined) =>
  listOf(value).flatMap((entry) => keptListing(entry) ?? []);

async function freshMessages(
  context: JobContext,
  listed: Listed[],
  readFrom: (conversation: string) => number,
) {
  const found: Message[] = [];
  for (const { conversation, encrypted, last_activity_at } of listed) {
    const after = readFrom(conversation.id);
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

async function readsFrom(context: JobContext, since: number) {
  const [kept] = await context
    .collection("messages/accounts")
    .query({ where: { source: context.module, source_id: ACCOUNT.id } });
  if (!kept?.synced_at) return () => since;
  const syncedAt = Date.parse(kept.synced_at) - OVERLAP_MS;
  const keptFrom = kept.newest ? Date.parse(kept.newest) : since;
  if (since < keptFrom) return () => since;
  const keptChats = new Set(
    (await context.collection("messages/conversations").query({ where: { account: kept.id } })).map(
      ({ source_id }) => source_id,
    ),
  );
  return (conversation: string) => (keptChats.has(conversation) ? syncedAt : since);
}

async function syncAccount(context: JobContext) {
  const source = context.module;
  const keptDays = await context.setting("messages-messenger/kept_days");
  const chats = await context.setting("messages-messenger/chats");
  const since = new Date(Date.now() - keptDays * 86_400_000);
  const readFrom = await readsFrom(context, since.getTime());
  return context.sources.syncing("messages", ACCOUNT, async () => {
    const listed = listingsIn(
      objectOf(await context.connectors.call(CONNECTOR, "conversations", { limit: chats }))
        .conversations,
    );
    const waiting = objectOf(await context.connectors.call(CONNECTOR, "take_events", {}));
    const messages = unique([
      ...(await freshMessages(context, listed, readFrom)),
      ...messagesIn(waiting.messages),
    ]).filter(({ sent_at }) => Date.parse(sent_at) >= since.getTime());
    const oldestFirst = [...messages].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
    const newest = new Map(oldestFirst.map((message) => [message.conversation, message]));
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
      newest: since.toISOString(),
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
    when: [
      { connector: CONNECTOR, on: ["changed", "added", "removed"] },
      { setting: "messages-messenger/kept_days" },
      { setting: "messages-messenger/chats" },
    ],
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
