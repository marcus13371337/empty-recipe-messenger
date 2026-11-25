# Messenger

The source that keeps the person's Facebook Messenger chats in the `messages` module, and sends through it. The 100 most recent chats and the last 30 days of messages are kept, in step as messages arrive and every 5 minutes.

With `messages-people` on, each Messenger person comes into People unlinked, under the name Messenger gives, for the person to link once; from then on chats show the People name.

It reaches Messenger through the `messenger` connection, `connections/messenger.ts`, which talks to the `messenger` helper program. How to add it, sign in, update and remove it is in the recipe's `RECIPE.md`.

End-to-end encrypted chats have no history to fetch, so they hold only what arrived since the helper first signed in. Starting a new chat isn't possible; a reply goes to a chat that is already there.
