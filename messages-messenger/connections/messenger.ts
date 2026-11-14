import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CodeConnection, HelperProgram, JsonObject, JsonValue } from "@empty/module-sdk";
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

type Waiting = { seq: number; kind: "messages" | "changed" | "conversations"; value: JsonValue };

const STRING = { type: "string", minLength: 1 };

export function messengerConnection(): CodeConnection {
  const people = new People();
  const encrypted = new Set<string>();
  const groups = new Set<string>();
  const known = new Map<string, Message>();
  let waiting: Waiting[] = [];
  let seq = 0;
  let state: { state: string; message: string | null } | null = null;

  const remember = (message: Message) => {
    known.delete(message.id);
    known.set(message.id, message);
    if (known.size > KNOWN) {
      const oldest = known.keys().next().value;
      if (oldest !== undefined) known.delete(oldest);
    }
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
          !message.read &&
          Date.parse(message.sent) <= Date.parse(at),
      );
      for (const message of reached) {
        const changed = { ...message, read: at };
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

  const history = async (helper: HelperProgram, args: JsonObject) => {
    const conversation = textOf(args.conversation) ?? "";
    if (encrypted.has(conversation)) return { messages: [], next: null };
    const answer = objectOf(
      await helper.request("messages", {
        conversation_id: conversation,
        limit: numberOf(args.limit) ?? 50,
        ...(textOf(args.before) !== null && { before: textOf(args.before) }),
      }),
    );
    const messages = listOf(answer.messages).flatMap((raw) => messageOf(raw, people) ?? []);
    for (const message of messages) remember(message);
    return { messages, next: textOf(answer.next) };
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
        await helper.request("send", {
          conversation_id: textOf(args.conversation) ?? "",
          ...(textOf(args.text) && { text: textOf(args.text) }),
          ...(files.length > 0 && { files }),
        }),
      );
      const messages = listOf(answer.messages).flatMap((raw) => messageOf(raw, people) ?? []);
      for (const message of messages) remember(message);
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
    const answer = objectOf(await helper.request("attachment", { ref: id }));
    const path = textOf(answer.path) ?? "";
    try {
      const mediaType = textOf(answer.type);
      return {
        attachment: {
          id,
          name: textOf(answer.name) ?? basename(path),
          mediaType,
          size: numberOf(answer.size) ?? 0,
        },
        file: {
          base64: (await readFile(path)).toString("base64"),
          mediaType: mediaType ?? "application/octet-stream",
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
            await helperProgram(HELPER).request("conversations", { limit: CONVERSATIONS }),
          );
          return {
            conversations: listOf(answer.conversations).flatMap((raw) => listed(raw) ?? []),
          };
        },
      },
      history: {
        description:
          "One chat's messages, newest page first. An end-to-end encrypted chat has none here.",
        does: "read",
        input: {
          type: "object",
          properties: { conversation: STRING, before: STRING, limit: { type: "integer" } },
          required: ["conversation"],
        },
        run: (args, { helperProgram }) => history(helperProgram(HELPER), args),
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
      state: {
        description: "The Messenger connection's last state, with its reason in plain words",
        does: "read",
        run: () => state,
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
