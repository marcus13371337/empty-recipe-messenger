import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HelperProgram, JsonObject, JsonValue } from "@empty/module-sdk";
import { appModule, testEngine } from "@empty/module-sdk/testing";
import * as actions from "./actions";
import { messengerConnection } from "./connections/messenger";
import * as jobs from "./jobs";
import { objectOf, textOf } from "./json";
import statement from "./module";
import manifest from "./module.json" with { type: "json" };

export const ME = { id: "100", name: "Ada" };
export const ANNA = { id: "200", name: "Anna" };
export const BO = { id: "300", name: "Bo" };

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

type Chat = { id: string; kind: "direct" | "group"; encrypted: boolean; people: (typeof ANNA)[] };

export function fakeHelper() {
  const folder = mkdtempSync(join(tmpdir(), "messenger-helper-"));
  const chats = new Map<string, Chat & { name: string; last: string; unread: boolean }>();
  const history = new Map<string, JsonObject[]>();
  const listeners = new Map<string, Set<(data: JsonValue) => void>>();
  const asked: { method: string; params: JsonObject }[] = [];
  let loggedIn = true;
  let echoes = true;
  let count = 0;

  const emit = (event: string, data: JsonValue) => {
    for (const listener of listeners.get(event) ?? []) listener(data);
  };
  const message = (
    chat: string,
    from: typeof ANNA,
    text: string,
    minutes: number,
    more: JsonObject = {},
  ): JsonObject => {
    count += 1;
    return {
      id: `m${count}`,
      conversation_id: chat,
      sender_id: from.id,
      from_me: from.id === ME.id,
      sent_at: minutesAgo(minutes),
      text,
      attachments: [],
      reactions: [],
      encrypted: chats.get(chat)?.encrypted ?? false,
      ...more,
    };
  };

  const answers: Record<string, (params: JsonObject) => JsonValue> = {
    conversations: () => ({
      conversations: [...chats.values()]
        .sort((a, b) => Date.parse(b.last) - Date.parse(a.last))
        .map((chat) => ({
          id: chat.id,
          name: chat.name,
          kind: chat.kind,
          encrypted: chat.encrypted,
          participants: chat.people.map(({ id, name }) => ({ id, name, avatar_url: "" })),
          last_activity_at: chat.last,
          unread: chat.unread,
        })),
    }),
    messages: ({ conversation_id, limit, before }) => {
      const chat = chats.get(String(conversation_id));
      if (!chat) throw new Error("That conversation is unknown.");
      if (chat.encrypted) throw new Error("Meta cannot serve the history of an encrypted chat.");
      const newestFirst = [...(history.get(chat.id) ?? [])].reverse();
      const start = typeof before === "string" ? Number(before) : 0;
      const end = start + (typeof limit === "number" ? limit : 50);
      return {
        messages: newestFirst.slice(start, end).reverse(),
        ...(end < newestFirst.length && { next: String(end) }),
      };
    },
    send: ({ conversation_id, text, files }) => {
      const chat = String(conversation_id);
      const attachments = (Array.isArray(files) ? files : []).map((file, index) => ({
        id: `a${index}`,
        kind: "file",
        type: "image/png",
        name: textOf(objectOf(file).name) ?? "",
        ref: `ref-${index}`,
      }));
      const sent = message(chat, ME, typeof text === "string" ? text : "", 0, { attachments });
      history.get(chat)?.push(sent);
      if (echoes) emit("message", sent);
      if (chats.get(chat)?.encrypted) return { messages: [sent] };
      const withoutRefs = attachments.map(({ ref: _ref, ...attachment }) => attachment);
      return { messages: [{ ...sent, attachments: withoutRefs }] };
    },
    attachment: ({ ref }) => {
      const path = join(folder, `${String(ref)}.png`);
      writeFileSync(path, "a picture");
      return { path, name: "picture.png", size: 9, type: "image/png" };
    },
  };

  const helper: HelperProgram = {
    request: async (method, params = {}) => {
      const given = objectOf(params);
      asked.push({ method, params: given });
      if (!loggedIn) throw new Error("Nobody is logged in yet. Log in first.");
      const answer = answers[method];
      if (!answer) throw new Error(`The helper has no such request: ${method}`);
      return answer(given);
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
    folder: async () => folder,
  };

  return {
    helper,
    folder,
    asked,
    chat(
      id: string,
      people: (typeof ANNA)[],
      options: { group?: boolean; encrypted?: boolean } = {},
    ) {
      chats.set(id, {
        id,
        kind: options.group ? "group" : "direct",
        encrypted: options.encrypted ?? false,
        people,
        name: people.map(({ name }) => name).join(", "),
        last: minutesAgo(60 * 24 * 365),
        unread: false,
      });
      history.set(id, []);
    },
    said(chat: string, from: typeof ANNA, text: string, minutes: number, more: JsonObject = {}) {
      const said = message(chat, from, text, minutes, more);
      history.get(chat)?.push(said);
      const kept = chats.get(chat);
      if (kept) chats.set(chat, { ...kept, last: String(said.sent_at), unread: from.id !== ME.id });
      return said;
    },
    arrives(chat: string, from: typeof ANNA, text: string, more: JsonObject = {}) {
      const said = message(chat, from, text, 0, more);
      const kept = chats.get(chat);
      if (kept) chats.set(chat, { ...kept, last: String(said.sent_at), unread: true });
      emit("message", said);
      return said;
    },
    emit,
    noEchoes() {
      echoes = false;
    },
    logOut(reason: string) {
      loggedIn = false;
      emit("state", { state: "logged_out", code: "bad_session", message: reason });
    },
    needsPerson(reason: string) {
      loggedIn = false;
      emit("state", { state: "needs_person", code: "needs_person", message: reason });
    },
  };
}

export async function setUp({ alongside = [] as string[] } = {}) {
  const fake = fakeHelper();
  const connection = messengerConnection();
  const mac = { control: async () => "" };
  const session = { keep: async () => {}, read: async () => null, forget: async () => {} };
  const context = { mac, session, helperProgram: () => fake.helper };
  const stop = new AbortController();
  let changes = 0;
  await connection.watch?.(() => (changes += 1), { ...context, signal: stop.signal });
  const engine = testEngine({
    modules: [
      await appModule("messages"),
      ...(await Promise.all(alongside.map((id) => appModule(id)))),
      { manifest, module: statement, actions, jobs },
    ],
    connectors: [{ name: "messenger", kind: "stdio" }],
    connector: async (_server, tool, args) => {
      const found = connection.tools[tool];
      if (!found) throw new Error(`No tool "${tool}".`);
      return found.run(args, context);
    },
  });
  const chat = async (source_id: string) => {
    const [conversation] = await engine
      .collection("messages/conversations")
      .query({ where: { source_id } });
    const messages = await engine.collection("messages/messages").query({
      where: { conversation: conversation?.id ?? "" },
      orderBy: [{ field: "sent_at" }],
    });
    return { conversation, messages };
  };
  return { engine, fake, chat, changes: () => changes, stop: () => stop.abort() };
}
