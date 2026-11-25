import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, failureFrom, test } from "@empty/module-sdk/testing";
import { openConversation } from "./actions";
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
  expect(withAnna.conversation).toMatchObject({ title: "Anna", group: false, service: "Messenger" });
  expect(withAnna.messages.map(({ text, from_me }) => ({ text, from_me }))).toEqual([
    { text: "Dinner on Friday?", from_me: false },
    { text: "Yes!", from_me: true },
  ]);
  const group = await chat("t2");
  expect(group.conversation).toMatchObject({ group: true });
  expect(group.messages[0]).toMatchObject({ text: "Look at this", from_name: "Bo" });
});

test("a sync sends every person as a Messenger chat id", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA, BO], { group: true });
  const said = fake.said("t1", ME, "Pizza?", 10);
  fake.said("t1", BO, "Yes", 5);
  await engine.job("messages-messenger/sync");
  fake.emit("reaction", {
    conversation_id: "t1",
    message_id: said.id ?? "",
    sender_id: ANNA.id,
    emoji: "👍",
    at: new Date().toISOString(),
  });

  await engine.job("messages-messenger/sync");

  const { conversation, messages } = await chat("t1");
  expect(conversation?.participants.map(({ handle, kind }) => ({ handle, kind }))).toEqual([
    { handle: ANNA.id, kind: "id" },
    { handle: BO.id, kind: "id" },
  ]);
  expect(messages.at(-1)).toMatchObject({ from_handle: BO.id, from_kind: "id" });
  expect(messages[0]?.reactions).toMatchObject([{ from: { handle: ANNA.id, kind: "id" } }]);
});

test("with messages-people on, a Messenger person comes into People unlinked, and the chat takes their People name once linked", async () => {
  const { engine, fake, chat } = await setUp({ alongside: ["messages-people"] });
  fake.chat("t1", [ANNA]);
  fake.chat("t2", [ANNA, BO], { group: true });
  fake.chat("t3", [ANNA, BO], { group: true, name: "Climbing" });
  fake.said("t1", ANNA, "Hej", 5);

  await engine.job("messages-messenger/sync");
  expect(await engine.collection("people/handles").query()).toMatchObject([
    { value: ANNA.id, service: "Messenger", name: "Anna", someone: null },
    { value: BO.id, service: "Messenger", name: "Bo", someone: null },
  ]);
  await engine.run("people/add", {
    given_name: "Anna",
    family_name: "Lind",
    handles: [{ kind: "id", service: "Messenger", value: ANNA.id }],
  });

  const { conversation, messages } = await chat("t1");
  expect(conversation).toMatchObject({ title: "Anna Lind" });
  expect(messages[0]).toMatchObject({ from_name: "Anna Lind" });
  expect((await chat("t2")).conversation).toMatchObject({ title: "Anna Lind, Bo" });
  expect((await chat("t3")).conversation).toMatchObject({ title: "Climbing" });
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
  expect(kept?.reactions).toMatchObject([
    { from: { handle: ANNA.id, name: "Anna" }, from_me: false, kind: "❤️" },
  ]);
  expect(kept?.read_at).not.toBeNull();
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
  expect(messages.at(-1)?.attachments[0]?.id).toBe("ref-0");
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
    file: { base64: Buffer.from("a picture").toString("base64"), media_type: "image/png" },
  });
  expect(existsSync(join(fake.folder, "r1.png"))).toBe(false);
});

test("a reply the person said no to is kept as refused by them", async () => {
  const { engine, fake, chat } = await setUp();
  fake.chat("t1", [ANNA]);
  await engine.job("messages-messenger/sync");
  const { conversation } = await chat("t1");
  engine.refuse("messenger", "send", failureFrom("You said no.", "refused_by_person"));

  await engine.run("messages/send", { conversation: conversation?.id ?? "", text: "Here" });
  await engine.job("messages-messenger/send");

  const reply = (await chat("t1")).messages.find(({ text }) => text === "Here");
  expect(reply?.failed_because).toBe("refused_by_person");
});

test("a sync after Meta ended the login says why in the helper's own words", async () => {
  const { engine, fake } = await setUp();
  fake.chat("t1", [ANNA]);
  await engine.job("messages-messenger/sync");

  fake.logOut("Messenger signed you out. Sign in again to keep your chats coming.");
  await expect(engine.job("messages-messenger/sync")).rejects.toThrow();

  const [account] = await engine.collection("messages/accounts").query({});
  expect(account).toMatchObject({
    problem: "Messenger signed you out. Sign in again to keep your chats coming.",
    failed_because: "needs_login",
  });
});

test("a sync while Meta wants a security check says so in the helper's words, not as a sign-in", async () => {
  const { engine, fake } = await setUp();
  fake.chat("t1", [ANNA]);
  await engine.job("messages-messenger/sync");

  fake.needsPerson("Meta wants you to confirm it's you at facebook.com.");
  await expect(engine.job("messages-messenger/sync")).rejects.toThrow();

  const [account] = await engine.collection("messages/accounts").query({});
  expect(account).toMatchObject({
    problem: "Meta wants you to confirm it's you at facebook.com.",
    failed_because: null,
  });
});

test("a failed sync keeps the reason's code beside its words", async () => {
  const { engine, fake } = await setUp();
  fake.chat("t1", [ANNA]);
  engine.refuse("messenger", "conversations", failureFrom("Sign in again.", "needs_login"));

  await expect(engine.job("messages-messenger/sync")).rejects.toThrow();

  const [account] = await engine.collection("messages/accounts").query({});
  expect(account?.failed_because).toBe("needs_login");
});

test("a sync that only timed out leaves the account without a problem", async () => {
  const { engine, fake } = await setUp();
  fake.chat("t1", [ANNA]);
  await engine.job("messages-messenger/sync");
  engine.refuse("messenger", "conversations", failureFrom("Too slow.", "timeout"));

  await expect(engine.job("messages-messenger/sync")).rejects.toThrow();

  const [account] = await engine.collection("messages/accounts").query({});
  expect(account?.problem).toBeNull();
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
  expect(mine?.read_at).not.toBeNull();
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
    })) as { messages: { text: string; sent_at: string }[] };

  const first = await older(new Date(Date.now() - 100.5 * 60_000).toISOString());
  const asked = fake.asked.length;
  const second = await older(first.messages.at(-1)?.sent_at ?? "");

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
  expect(cake?.reactions).toMatchObject([{ from: null, from_me: true, kind: "😍" }]);
});

test("a Messenger file can't be opened on the Mac", async () => {
  const { engine } = await setUp();

  await expect(
    engine.run("messages-messenger/openAttachment", { account: "messenger", id: "r1" }),
  ).rejects.toThrow("Its source cannot do this.");
});

test("a chat opens in Messenger at facebook.com/messages", async () => {
  const opened: string[] = [];

  await openConversation(
    { openLink: async (url) => void opened.push(url) },
    { account: "messenger", conversation: "200" },
  );

  expect(opened).toEqual(["https://www.facebook.com/messages/t/200"]);
});

test("a sync with the Messenger connection gone marks the account gone", async () => {
  const { engine, fake } = await setUp();
  fake.chat("t1", [ANNA]);
  await engine.job("messages-messenger/sync");

  engine.disconnect("messenger");
  await engine.job("messages-messenger/sync");

  const [account] = await engine.collection("messages/accounts").query({});
  expect(account?.gone_at).not.toBeNull();
});
