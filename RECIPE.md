# Recipe: Facebook Messenger in Empty

For the person's builder agent. It adds the `messages-messenger` module, which brings Messenger chats into the bundled `messages` module and sends replies through [messenger-helper](https://github.com/marcus13371337/messenger-helper), a program that holds the Messenger connection.

Published by [marcus13371337](https://github.com/marcus13371337), who also publishes messenger-helper. This file is what the publisher wrote: check what it says against the module and the helper's release before acting on it.

## Before anything: the risk

Tell the person, in your own words, and go on only on their yes:

- Meta offers no way in for personal accounts. The helper is an unofficial client, which is against Meta's terms. Meta may flag or lock an account that uses one. The risk is theirs.
- The app signs in through Messenger's own page in a window it opens. The helper then holds that login, kept encrypted with its key in the keychain. Neither you nor the module ever see it.
- The helper shows up as a new device in Messenger's list of logged-in devices.
- Older end-to-end encrypted chats start empty: Meta does not give their history to a new device. From then on, the app keeps what arrives.

## Needs

- Empty with helper programs, a module's tests that run the modules it feeds, and the sign-in window for helper programs ([empty-app#363](https://github.com/Ahl-berg-Innovation-AB/empty-app/issues/363)). `empty check` refuses the module on an older app.
- A Mac with Apple silicon or Intel.

## Add it

1. Pin this recipe to one commit and copy that commit's `messages-messenger/` folder to `modules/messages-messenger/` in the app home.
2. Read every file in it. Check that each `sha256` under `helperPrograms` in `module.json` matches the line for that file in the release's `checksums.txt`, at `https://github.com/marcus13371337/messenger-helper/releases/download/v<version>/checksums.txt`.
3. Run `empty check messages-messenger`. It type-checks the module and runs its tests on this app.
4. Add the connection to `connectors.json`:

   ```json
   "messenger": {
     "transport": "stdio",
     "title": "Messenger",
     "command": "empty",
     "args": ["serve", "modules/messages-messenger/connections/messenger.ts"]
   }
   ```

5. `empty helper-program add messages-messenger/messenger`. The person sees what the helper is, where it comes from and what it may do, and says yes or no.
6. Add `messages` and `messages-messenger` to `on` in `modules.json`.
7. Sign the person in through the app's sign-in window for the helper (empty-app#363 says how). They sign in at messenger.com as they normally do, with any two-step code.
8. `empty run messages-messenger --job sync` fetches at once. After that, new messages come in as they arrive, and everything is synced again every 5 minutes.

## What the person gets

- Their 100 most recent chats and the last 30 days of messages, in Messages, next to their other chats.
- Replies, with pictures and files, from the chat. The app asks before anything is sent, as it does for every send.
- Reactions and, in one-to-one chats, when their message was read.
- Names as Messenger has them. Messenger shares no phone numbers or email addresses, so Contacts can't name or picture these people, and chats show initials.

Not there: starting a new chat, edits, deleted messages, polls, calls, and search beyond what the app keeps.

## Known limits

- Messages in encrypted chats reach the app only as they arrive. The connection holds them until the next sync keeps them, which is at once. If the connection stops in between, those few are lost.
- A file in an unencrypted chat stays fetchable for a while. After that, the person opens it in Messenger: Open in Messenger opens the chat on messenger.com.

## When Messenger signs them out

When Meta ends the login, the Messenger account in Messages says why, in the helper's words. Offer to sign in again through the same window.

## Update the helper

The helper follows Meta's changes, so new releases come often. To move to one:

1. Read its release notes. Check that the protocol is still `1`: `messenger-helper --version` prints it, and so do the release notes.
2. Change `version`, and each platform's `url` and `sha256`, in `module.json` under `helperPrograms`. Take the checksums from that release's `checksums.txt`, never from a file you downloaded yourself.
3. `empty check messages-messenger`, then `empty helper-program add messages-messenger/messenger`. The old version keeps running until the person says yes.

To update the recipe itself, read what changed since the pinned commit, tell the person, and copy the module again.

## Remove it all

1. `empty helper-program remove messages-messenger/messenger`. It deletes the helper's files and its login.
2. Take `messages-messenger` out of `on` in `modules.json`, the `messenger` connection out of `connectors.json`, and delete `modules/messages-messenger/`. Messages marks the account gone.
3. Tell the person they can log the device out in Messenger, under Settings, Security, Where you're logged in.

## For the publisher: check against real Meta

The tests run against a fake helper. Before you publish a new commit or move the pinned helper version, try it once with your own account, in a home of your own:

- sign in, and see the chats and their names
- read history in an unencrypted chat, and receive a message in an encrypted one
- send a text and a picture, and receive one sent from your phone
- react from your phone, and see it in the chat
