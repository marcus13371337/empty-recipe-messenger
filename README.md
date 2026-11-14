# empty-recipe-messenger

A recipe for [Empty](https://empty.rcusahlberg.se): a person's builder agent follows [RECIPE.md](RECIPE.md) to bring their Facebook Messenger chats into the app. It adds the `messages-messenger` module, which talks to [messenger-helper](https://github.com/marcus13371337/messenger-helper).

**Unofficial.** Meta offers no API for personal accounts. Using an unofficial client is against Meta's terms and may get an account flagged. The person takes that risk knowingly; the recipe has their builder tell them first.

## Layout

- `RECIPE.md`: the steps for the builder: the risk, adding, updating and removing.
- `messages-messenger/`: the module the builder copies into the app home.
  - `connections/messenger.ts` speaks the helper's [protocol](https://github.com/marcus13371337/messenger-helper/blob/main/PROTOCOL.md) and keeps what arrives until a sync takes it.
  - `jobs.ts` syncs and sends through the `messages` module, `actions.ts` answers its earlier-messages and attachment questions.
  - `messenger.test.ts` runs it all against `fakeHelper.test-harness.ts`, a stand-in for the helper.

## Checks

`empty check messages-messenger` in an app home type-checks the module and runs its tests on that app. CI does the same weekly against the newest Empty release, so a change in Empty that breaks the recipe shows here.
