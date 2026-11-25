# Messenger

The source that keeps the person's Facebook Messenger chats in the `messages` module, and sends through it. It keeps them in step as messages arrive and every 5 minutes.

With `messages-people` on, each Messenger person comes into People unlinked, under the name Messenger gives, for the person to link once; from then on chats show the People name.

It reaches Messenger through the `messenger` connection, `connections/messenger.ts`, which talks to the `messenger` helper program. How to add it, sign in, update and remove it is in the recipe's `RECIPE.md`.

End-to-end encrypted chats have no history to fetch, so they hold only what arrived since the helper first signed in. Starting a new chat isn't possible; a reply goes to a chat that is already there.

## What it decides

- **How long messages are kept**: `kept_days`, `30`. A message dropped from an encrypted chat can't be fetched again.
- **How many chats are listed**: `chats`, `100`, the most recent.
- **How often it syncs and sends**: syncs every 5 minutes and sends every minute, besides each change. Fixed, as in the bundled `messages-macos`.

Raising either setting reads every listed chat again over the kept days, at once. If that was cut short, `empty run messages-messenger --job resync` reads them again.
