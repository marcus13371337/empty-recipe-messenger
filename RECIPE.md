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

- Empty 0.9.1 or newer: helper programs, a module's tests that run the modules it feeds, and the sign-in window for helper programs ([empty-app#363](https://github.com/Ahl-berg-Innovation-AB/empty-app/issues/363)). `empty check` refuses the module on an older app.
- A Mac with Apple silicon or Intel.

## Add it

1. Pin this recipe to one commit and put that commit's files in `recipes/empty-recipe-messenger/` in the app home, not in `modules/`.
2. Read every file in `messages-messenger/`. Check that each `sha256` under `helperPrograms` in `module.json` matches the line for that file in the release's `checksums.txt`, at `https://github.com/marcus13371337/messenger-helper/releases/download/v<version>/checksums.txt`.
3. Run `empty check recipes/empty-recipe-messenger/messages-messenger`. It type-checks the module and runs its tests on this app.
4. Tell the person about the risk (above) and who publishes this, and go on only on their yes.
5. Copy `messages-messenger/` to `modules/messages-messenger/`, and add a last line to its `README.md`: `From marcus13371337/empty-recipe-messenger at <commit>.`
6. Add the connection to `connectors.json`:

   ```json
   "messenger": {
     "transport": "stdio",
     "title": "Messenger",
     "command": "empty",
     "args": ["serve", "modules/messages-messenger/connections/messenger.ts"]
   }
   ```

7. `empty helper-program add messages-messenger/messenger`. The person sees what the helper is, where it comes from and what it may do, and says yes or no. On their yes, the app opens its sign-in window at messenger.com. They sign in there as they normally do, with any two-step code. The window closes by itself once they are signed in, and the app hands the login to the helper. You never see it, and never ask them to copy cookies or a password.
8. Add `messages` to `on` in `modules.json`, if it is not there.
9. Wait until `empty status` shows the helper as `running`, not `starting` or `signed_out`. If it shows `failed`, read its error and fix that before going on. If the person closed the window, or left it until it closed by itself after 15 minutes, `empty helper-program sign-in messages-messenger/messenger` opens it again; so does Sign in under Settings → Connections.
10. `empty run messages-messenger --job sync` fetches at once. After that, new messages come in as they arrive, and everything is synced again every 5 minutes.

## What the person gets

- Their 100 most recent chats and the last 30 days of messages, in Messages, next to their other chats.
- Replies, with pictures and files, from the chat. The app asks before anything is sent, as it does for every send.
- Reactions and, in one-to-one chats, when their message was read.
- Names as Messenger has them. Messenger shares no phone numbers or email addresses, so Contacts can't name or picture these people, and chats show initials.

Not there: starting a new chat, edits, deleted messages, polls, calls, and search beyond what the app keeps.

## Known limits

- Messages in encrypted chats reach the app only as they arrive. The connection holds them until the next sync keeps them, which is at once. If the connection stops in between, those few are lost.
- Pictures show in the chat. Other files can't be opened on the Mac from here: the person opens the chat in Messenger, which opens it on messenger.com.
- A file in an unencrypted chat stays fetchable for a while; after that, the same goes for pictures.
- The person's own reactions are marked as theirs once the app has seen one of their messages in that chat.

## When Messenger signs them out

When Meta ends the login, the app forgets it and asks the person once to sign in again, which opens the same window. The Messenger account in Messages says why, in the helper's words. If they said no, Settings → Connections shows the helper as signed out with a Sign in button; offer to open the window with `empty helper-program sign-in messages-messenger/messenger`.

Each sign-in after Meta ended one is a new device in Messenger's list of logged-in devices. Chats and messages the app already keeps stay; encrypted chats carry on only with messages that arrive after it.

When Meta wants a security check instead, the account in Messages says so, but the app does not ask, and the helper stays `running` without a login. The person finishes the check at messenger.com in their own browser. Then `empty helper-program stop messages-messenger/messenger` and `empty helper-program start messages-messenger/messenger` make the helper log in again with the login it keeps. If Meta no longer takes that login, the app asks the person to sign in again, as above.

## Update the helper

The helper follows Meta's changes, so new releases come often. To move to one:

1. Read its release notes. Check that the protocol is still `1`: `messenger-helper --version` prints it, and so do the release notes.
2. Change `version`, and each platform's `url` and `sha256`, in `module.json` under `helperPrograms`. Take the checksums from that release's `checksums.txt`, never from a file you downloaded yourself.
3. `empty check messages-messenger`, then `empty helper-program add messages-messenger/messenger`. The old version keeps running until the person says yes.

To update the recipe itself, read what changed between the commit named in `modules/messages-messenger/README.md` and the newest, tell the person, check it in `recipes/` as above, and copy the module again with the new commit.

## Remove it all

1. `empty helper-program remove messages-messenger/messenger`. It deletes the helper's files and its login.
2. Take the `messenger` connection out of `connectors.json`, then `empty run messages-messenger --job sync`: with the connection gone, Messages marks the account gone.
3. Delete `modules/messages-messenger/` and `recipes/empty-recipe-messenger/`.
4. Tell the person they can log the device out in Messenger, under Settings, Security, Where you're logged in.

## For the publisher: check against real Meta

The tests run against a fake helper. Before you publish a new commit or move the pinned helper version, try it once with your own account, in a home of your own:

- sign in, and see the chats and their names
- read history in an unencrypted chat, and receive a message in an encrypted one
- send a text and a picture, and receive one sent from your phone
- react from your phone, and see it in the chat
