import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@empty/module-sdk/testing";
import { ANNA, BO, ME, setUp } from "./fakeHelper.test-harness";
import { UNSUPPORTED } from "./messenger";

test("a sync keeps the chats and their last 30 days, named as in Messenger", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA]);
  fake.chat("t2", [ANNA, BO], { group: true });
  fake.said("t1", ANNA, "Long ago", 60 * 24 * 40);
  fake.said("t1", ANNA, "Dinner on Friday?", 30);
  fake.said("t1", ME, "Yes!", 20);
  fake.said("t2", BO, "Look at this", 10);

  await engine.job("messages-messenger/sync");

  const withAnna = await chat("t1");
  expect(withAnna.conversation).toMatchObject({ name: "Anna", group: false, service: "Messenger" });
  expect(withAnna.messages.map(({ text, from_me }) => ({ text, from_me }))).toEqual([
    { text: "Dinner on Friday?", from_me: false },
    { text: "Yes!", from_me: true },
  ]);
  const group = await chat("t2");
  expect(group.conversation).toMatchObject({ group: true });
  expect(group.messages[0]).toMatchObject({ text: "Look at this", from_name: "Bo" });
});

test("an encrypted chat keeps what arrives, since Meta serves no history for it", async () => {
  const { engine, fake, chat, changes } = await setUp();
  fake.chat("e1", [ANNA], { encrypted: true });
  fake.said("e1", ANNA, "Sent before the helper was here", 60);
  await engine.job("messages-messenger/sync");

  fake.arrives("e1", ANNA, "Are you there?");
  expect(changes()).toBe(1);
  await engine.job("messages-messenger/sync");
  await engine.job("messages-messenger/sync");

  expect((await chat("e1")).messages.map(({ text }) => text)).toEqual(["Are you there?"]);
  expect(fake.asked.filter(({ method }) => method === "messages")).toEqual([]);
});

test("a reaction and a read receipt change a message already kept", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("e1", [ANNA], { encrypted: true });
  await engine.job("messages-messenger/sync");
  const mine = fake.arrives("e1", ME, "See you at eight");
  await engine.job("messages-messenger/sync");

  fake.emit("reaction", {
    conversation_id: "e1",
    message_id: mine.id ?? "",
    sender_id: ANNA.id,
    emoji: "❤️",
    at: new Date().toISOString(),
  });
  fake.emit("read", {
    conversation_id: "e1",
    reader_id: ANNA.id,
    read_at: new Date().toISOString(),
  });
  await engine.job("messages-messenger/sync");

  const [kept] = (await chat("e1")).messages;
  expect(kept?.reactions).toEqual([
    { from: { handle: ANNA.id, name: "Anna" }, from_me: false, kind: "❤️" },
  ]);
  expect(kept?.read).not.toBeNull();
});

test("a message Messenger can't carry says to open it in Messenger", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA]);
  fake.said("t1", ANNA, "", 5, { unsupported: true });

  await engine.job("messages-messenger/sync");

  expect((await chat("t1")).messages.map(({ text }) => text)).toEqual([UNSUPPORTED]);
});

test("a reply with a picture goes out through the helper, which gets the file in its folder", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA]);
  fake.said("t1", ANNA, "Photo?", 5);
  await engine.job("messages-messenger/sync");
  const { conversation } = await chat("t1");

  await engine.run("messages/send", {
    conversation: conversation?.id ?? "",
    text: "Here",
    files: [{ name: "beach.png", base64: Buffer.from("a picture").toString("base64") }],
  });
  await engine.job("messages-messenger/send");

  const sent = fake.asked.find(({ method }) => method === "send");
  expect(sent?.params).toMatchObject({ conversation_id: "t1", text: "Here" });
  expect(JSON.stringify(sent?.params.files)).toContain(join(fake.folder, "outgoing"));
  expect(readdirSync(join(fake.folder, "outgoing"))).toEqual([]);
  const messages = (await chat("t1")).messages;
  expect(messages.at(-1)).toMatchObject({ text: "Here", from_me: true, pending: null });
});

test("an attachment is fetched from the helper, and its file in the helper's folder is removed", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA]);
  fake.said("t1", ANNA, "", 5, {
    attachments: [{ id: "a1", kind: "image", type: "image/png", name: "cat.png", ref: "r1" }],
  });
  await engine.job("messages-messenger/sync");
  const [message] = (await chat("t1")).messages;
  const attachment = message?.attachments[0];

  const answer = await engine.run("messages-messenger/attachment", {
    account: "messenger",
    id: attachment?.id ?? "",
  });

  expect(answer).toMatchObject({
    kept: "here",
    file: { base64: Buffer.from("a picture").toString("base64"), mediaType: "image/png" },
  });
  expect(existsSync(join(fake.folder, "r1.png"))).toBe(false);
});

test("a sync after Meta ended the login says why in the helper's own words", async () => {
  const { engine, fake } = await setUp();
  fake.chat("t1", [ANNA]);
  await engine.job("messages-messenger/sync");

  fake.logOut("Messenger signed you out. Sign in again to keep your chats coming.");
  await expect(engine.job("messages-messenger/sync")).rejects.toThrow();

  const [account] = await engine.collection("messages/accounts").query({});
  expect(account?.problem).toBe(
    "Messenger signed you out. Sign in again to keep your chats coming.",
  );
});

test("earlier messages come from the helper's history, older than the ones asked before", async () => {
  const { engine, fake } = await setUp();
  fake.chat("t1", [ANNA]);
  fake.said("t1", ANNA, "First", 60);
  fake.said("t1", ANNA, "Second", 30);
  fake.said("t1", ANNA, "Third", 10);

  const { messages } = (await engine.run("messages-messenger/older", {
    account: "messenger",
    conversation: "t1",
    before: new Date(Date.now() - 20 * 60_000).toISOString(),
    limit: 10,
  })) as { messages: { text: string }[] };

  expect(messages.map(({ text }) => text)).toEqual(["Second", "First"]);
});

test("a chat keeps its last line when a sync brings nothing new", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA]);
  fake.chat("e1", [ANNA], { encrypted: true });
  fake.said("t1", ANNA, "Dinner on Friday?", 30);
  await engine.job("messages-messenger/sync");
  fake.arrives("e1", ANNA, "Are you there?");
  await engine.job("messages-messenger/sync");

  await engine.job("messages-messenger/sync");

  expect((await chat("t1")).conversation).toMatchObject({ last_text: "Dinner on Friday?" });
  expect((await chat("e1")).conversation).toMatchObject({ last_text: "Are you there?" });
});

test("a chat busier than one page since the last sync keeps every message", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA]);
  for (let minute = 300; minute > 0; minute -= 1) fake.said("t1", ANNA, `Line ${minute}`, minute);

  await engine.job("messages-messenger/sync");

  expect((await chat("t1")).messages).toHaveLength(300);
});

test("a read receipt stays when a later sync reads the chat again", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA]);
  fake.said("t1", ME, "See you at eight", 2);
  await engine.job("messages-messenger/sync");

  fake.emit("read", {
    conversation_id: "t1",
    reader_id: ANNA.id,
    read_at: new Date().toISOString(),
  });
  await engine.job("messages-messenger/sync");
  fake.said("t1", ANNA, "Great", 0);
  await engine.job("messages-messenger/sync");

  const [mine] = (await chat("t1")).messages;
  expect(mine?.read).not.toBeNull();
});

test("a reply in an encrypted chat is kept from the helper's answer, before its echo arrives", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("e1", [ANNA], { encrypted: true });
  fake.arrives("e1", ANNA, "Hi");
  await engine.job("messages-messenger/sync");
  fake.noEchoes();
  const { conversation } = await chat("e1");

  await engine.run("messages/send", { conversation: conversation?.id ?? "", text: "Hello" });
  await engine.job("messages-messenger/send");

  const messages = (await chat("e1")).messages;
  expect(messages.map(({ text, pending }) => ({ text, pending }))).toEqual([
    { text: "Hi", pending: null },
    { text: "Hello", pending: null },
  ]);
});

test("asking for earlier messages twice goes on from where the first answer ended", async () => {
  const { engine, fake } = await setUp();
  fake.chat("t1", [ANNA]);
  for (let minute = 500; minute > 0; minute -= 1) fake.said("t1", ANNA, `Line ${minute}`, minute);
  const older = async (before: string) =>
    (await engine.run("messages-messenger/older", {
      account: "messenger",
      conversation: "t1",
      before,
      limit: 150,
    })) as { messages: { text: string; sent: string }[] };

  const first = await older(new Date(Date.now() - 100.5 * 60_000).toISOString());
  const asked = fake.asked.length;
  const second = await older(first.messages.at(-1)?.sent ?? "");

  expect(first.messages[0]?.text).toBe("Line 101");
  expect(second.messages[0]?.text).toBe("Line 251");
  expect(second.messages.at(-1)?.text).toBe("Line 400");
  expect(fake.asked.slice(asked).every(({ params }) => params.before !== undefined)).toBe(true);
});

test("the person's own reaction in a chat's history is theirs", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA]);
  fake.said("t1", ANNA, "Cake!", 10, { reactions: [{ sender_id: ME.id, emoji: "😍" }] });
  fake.said("t1", ME, "On my way", 5);

  await engine.job("messages-messenger/sync");

  const [cake] = (await chat("t1")).messages;
  expect(cake?.reactions).toEqual([{ from: null, from_me: true, kind: "😍" }]);
});

test("a Messenger file can't be opened on the Mac, and says to open the chat in Messenger", async () => {
  const { engine } = await setUp();

  await expect(
    engine.run("messages-messenger/openAttachment", { account: "messenger", id: "r1" }),
  ).rejects.toThrow("open the chat there");
});
