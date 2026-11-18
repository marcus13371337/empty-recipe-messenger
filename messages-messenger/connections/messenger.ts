import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  CodeConnection,
  FailedBecause,
  HelperProgram,
  JsonObject,
  JsonValue,
} from "@empty/module-sdk";
import { listOf, numberOf, objectOf, textOf } from "../json";
import {
  HELPER,
  type Listed,
  listedOf,
  type Message,
  messageOf,
  NO_REF,
  People,
  reactionOf,
} from "../messenger";

const CONVERSATIONS = 100;
const KNOWN = 5_000;
const PAGE = 100;
const PAGES = 20;

type Waiting = { seq: number; kind: "messages" | "changed" | "conversations"; value: JsonValue };

const STRING = { type: "string", minLength: 1 };

const FINAL_STATES: Record<string, { reason?: FailedBecause }> = {
  logged_out: { reason: "needs_login" },
  needs_person: {},
};
export function messengerConnection(): CodeConnection {
  const people = new People();
  const encrypted = new Set<string>();
  const groups = new Set<string>();
  const cursors = new Map<string, { oldest: string; next: string | null }>();
  const known = new Map<string, Message>();
  let waiting: Waiting[] = [];
  let seq = 0;
  let state: { state: string; message: string | null } | null = null;

  const request = async (helper: HelperProgram, method: string, params: JsonObject) => {
    try {
      return await helper.request(method, params);
    } catch (error) {
      const final =
        state && Object.hasOwn(FINAL_STATES, state.state) ? FINAL_STATES[state.state] : undefined;
      if (state === null || final === undefined) throw error;
      const words = state.message ?? (error instanceof Error ? error.message : String(error));
      throw Object.assign(new Error(words), final);
    }
  };

  const remember = (given: Message) => {
    const readAt = given.read_at ?? known.get(given.id)?.read_at;
    const message = readAt ? { ...given, read_at: readAt } : given;
    known.delete(message.id);
    known.set(message.id, message);
    if (known.size > KNOWN) {
      const oldest = known.keys().next().value;
      if (oldest !== undefined) known.delete(oldest);
    }
    return message;
  };
  const wait = (kind: Waiting["kind"], value: Message | Listed) => {
    seq += 1;
    waiting.push({ seq, kind, value: JSON.parse(JSON.stringify(value)) });
  };
  const listed = (raw: JsonValue) => {
    const found = listedOf(raw, people);
    if (found === null) return null;
    if (found.encrypted) encrypted.add(found.conversation.id);
    if (found.conversation.group) groups.add(found.conversation.id);
    return found;
  };

  const heard: Record<string, (data: JsonValue) => boolean> = {
    message: (data) => {
      const message = messageOf(data, people);
      if (message === null) return false;
      remember(message);
      wait("messages", message);
      return true;
    },
    reaction: (data) => {
      const { message_id, sender_id, emoji } = objectOf(data);
      const message = known.get(textOf(message_id) ?? "");
      const from = textOf(sender_id);
      if (!message || from === null) return false;
      const others = message.reactions.filter(
        (reaction) => (reaction.from?.handle ?? people.me) !== from,
      );
      const kind = textOf(emoji);
      const changed = {
        ...message,
        reactions: kind ? [...others, reactionOf(from, kind, people)] : others,
      };
      remember(changed);
      wait("changed", changed);
      return true;
    },
    read: (data) => {
      const { conversation_id, read_at } = objectOf(data);
      const conversation = textOf(conversation_id);
      const at = textOf(read_at);
      if (conversation === null || at === null || groups.has(conversation)) return false;
      const reached = [...known.values()].filter(
        (message) =>
          message.conversation === conversation &&
          message.from_me &&
          !message.read_at &&
          Date.parse(message.sent_at) <= Date.parse(at),
      );
      for (const message of reached) {
        const changed = { ...message, read_at: at };
        remember(changed);
        wait("changed", changed);
      }
      return reached.length > 0;
    },
    conversation: (data) => {
      const found = listed(data);
      if (found === null) return false;
      wait("conversations", found);
      return true;
    },
    state: (data) => {
      const said = objectOf(data);
      state = { state: textOf(said.state) ?? "unknown", message: textOf(said.message) };
      return said.state === "connected";
    },
  };

  const take = () => {
    const of = (kind: Waiting["kind"]) =>
      waiting.filter((entry) => entry.kind === kind).map(({ value }) => value);
    return {
      upTo: seq,
      messages: of("messages"),
      changed: of("changed"),
      conversations: of("conversations"),
    };
  };

  const mapped = (raws: JsonValue[]) => {
    people.learnMe(raws);
    return raws.flatMap((raw) => {
      const message = messageOf(raw, people);
      return message ? [remember(message)] : [];
    });
  };

  const page = async (helper: HelperProgram, conversation: string, before: string | null) => {
    const answer = objectOf(
      await request(helper, "messages", {
        conversation_id: conversation,
        limit: PAGE,
        ...(before !== null && { before }),
      }),
    );
    return { messages: mapped(listOf(answer.messages)), next: textOf(answer.next) };
  };

  const since = async (helper: HelperProgram, conversation: string, after: number) => {
    if (encrypted.has(conversation)) return [];
    const found: Message[] = [];
    let next: string | null = null;
    for (let fetched = 0; fetched < PAGES; fetched += 1) {
      const answer = await page(helper, conversation, next);
      found.push(...answer.messages);
      next = answer.next;
      if (next === null || answer.messages.some(({ sent_at }) => Date.parse(sent_at) <= after))
        break;
    }
    return found.filter(({ sent_at }) => Date.parse(sent_at) > after);
  };

  const earlier = async (
    helper: HelperProgram,
    conversation: string,
    before: number,
    limit: number,
  ) => {
    const older = (messages: Iterable<Message>) =>
      [...messages].filter(
        (message) => message.conversation === conversation && Date.parse(message.sent_at) < before,
      );
    const cursor = cursors.get(conversation);
    let next = cursor && Date.parse(cursor.oldest) <= before ? cursor.next : null;
    const found = new Map(
      older(cursor && next !== null ? known.values() : []).map((m) => [m.id, m]),
    );
    for (
      let fetched = 0;
      fetched < PAGES && found.size < limit && !encrypted.has(conversation);
      fetched += 1
    ) {
      const answer = await page(helper, conversation, next);
      for (const message of older(answer.messages)) found.set(message.id, message);
      const oldest = answer.messages.map(({ sent_at }) => sent_at).sort()[0];
      if (oldest) cursors.set(conversation, { oldest, next: answer.next });
      next = answer.next;
      if (next === null) break;
    }
    return [...found.values()]
      .sort((a, b) => Date.parse(b.sent_at) - Date.parse(a.sent_at))
      .slice(0, limit);
  };

  const send = async (helper: HelperProgram, args: JsonObject) => {
    const folder = join(await helper.folder(), "outgoing");
    await mkdir(folder, { recursive: true });
    const files = await Promise.all(
      listOf(args.files).map(async (value) => {
        const file = objectOf(value);
        const name = basename(textOf(file.name) ?? "file");
        const path = join(folder, `${randomUUID()}-${name}`);
        await writeFile(path, Buffer.from(textOf(file.base64) ?? "", "base64"));
        return { path, name };
      }),
    );
    try {
      const answer = objectOf(
        await request(helper, "send", {
          conversation_id: textOf(args.conversation) ?? "",
          ...(textOf(args.text) && { text: textOf(args.text) }),
          ...(files.length > 0 && { files }),
        }),
      );
      const answered = listOf(answer.messages);
      const echoed = answered.flatMap((raw) => known.get(textOf(objectOf(raw).id) ?? "") ?? []);
      const fresh = mapped(answered.filter((raw) => !known.has(textOf(objectOf(raw).id) ?? "")));
      for (const message of fresh) wait("messages", message);
      const messages = [...echoed, ...fresh];
      const problem = objectOf(answer.problem);
      if (textOf(problem.message)) {
        throw new Error(`Only part of it went out: ${textOf(problem.message)}`);
      }
      return { messages };
    } finally {
      await Promise.all(files.map(({ path }) => rm(path, { force: true })));
    }
  };

  const attachment = async (helper: HelperProgram, id: string) => {
    if (id.startsWith(NO_REF)) {
      throw new Error("Messenger has not handed this file over yet. Try again in a minute.");
    }
    const answer = objectOf(await request(helper, "attachment", { ref: id }));
    const path = textOf(answer.path) ?? "";
    try {
      const mediaType = textOf(answer.type);
      return {
        attachment: {
          id,
          name: textOf(answer.name) ?? basename(path),
          media_type: mediaType,
          size: numberOf(answer.size) ?? 0,
        },
        file: {
          base64: (await readFile(path)).toString("base64"),
          media_type: mediaType ?? "application/octet-stream",
        },
        kept: "here",
      };
    } finally {
      await rm(path, { force: true });
    }
  };

  return {
    tools: {
      conversations: {
        description: "The most recent Messenger chats, newest activity first",
        does: "read",
        run: async (_args, { helperProgram }) => {
          const answer = objectOf(
            await request(helperProgram(HELPER), "conversations", { limit: CONVERSATIONS }),
          );
          return {
            conversations: listOf(answer.conversations).flatMap((raw) => listed(raw) ?? []),
          };
        },
      },
      since: {
        description:
          "One chat's messages sent after a time, oldest first. An end-to-end encrypted chat has none here.",
        does: "read",
        input: {
          type: "object",
          properties: { conversation: STRING, after: STRING },
          required: ["conversation", "after"],
        },
        run: async (args, { helperProgram }) => ({
          messages: await since(
            helperProgram(HELPER),
            textOf(args.conversation) ?? "",
            Date.parse(textOf(args.after) ?? ""),
          ),
        }),
      },
      earlier: {
        description: "One chat's messages sent before a time, newest first",
        does: "read",
        input: {
          type: "object",
          properties: { conversation: STRING, before: STRING, limit: { type: "integer" } },
          required: ["conversation", "before", "limit"],
        },
        run: async (args, { helperProgram }) => ({
          messages: await earlier(
            helperProgram(HELPER),
            textOf(args.conversation) ?? "",
            Date.parse(textOf(args.before) ?? ""),
            numberOf(args.limit) ?? 50,
          ),
        }),
      },
      take_events: {
        description: "What arrived since the last drop_events: messages, changes and chats",
        does: "read",
        run: () => take(),
      },
      drop_events: {
        description: "Forget what take_events gave, up to upTo, once it is kept",
        does: "read",
        input: { type: "object", properties: { upTo: { type: "integer" } }, required: ["upTo"] },
        run: (args) => {
          const upTo = numberOf(args.upTo) ?? 0;
          waiting = waiting.filter((entry) => entry.seq > upTo);
          return null;
        },
      },
      send: {
        description: "Send text, files or both to a Messenger chat",
        input: {
          type: "object",
          properties: {
            conversation: STRING,
            text: { type: "string" },
            files: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, base64: { type: "string" } },
                required: ["name", "base64"],
              },
            },
          },
          required: ["conversation"],
        },
        run: (args, { helperProgram }) => send(helperProgram(HELPER), args),
      },
      attachment: {
        description: "One attachment's file",
        does: "read",
        input: { type: "object", properties: { id: STRING }, required: ["id"] },
        run: (args, { helperProgram }) => attachment(helperProgram(HELPER), textOf(args.id) ?? ""),
      },
    },
    watch: (emit, { helperProgram, signal }) => {
      const helper = helperProgram(HELPER);
      const stops = Object.entries(heard).map(([event, hear]) =>
        helper.on(event, (data) => {
          if (hear(data)) emit();
        }),
      );
      signal.addEventListener("abort", () => {
        for (const stop of stops) stop();
      });
    },
  };
}

export default messengerConnection();
