# Signing in to Google from a cloud browser

Why a passkey sign-in stops at "Verifying it's you" in a bot's browser, and the ways that work.

A bot's browser opens Google's sign-in, you enter your email, and the page stops at **Verifying it's you** with **Complete sign-in using your passkey** (or **Use your passkey to confirm it's really you**, or **Use your security key**). The passkey step can't finish there: Google may say something went wrong, and offers **Try another way**.

A passkey lives on your own phone or computer: Windows Hello, Touch ID, your phone's screen lock, or a security key. Signing in with it needs that device:

- **On SanRemes Cloud** the browser runs on a computer in the cloud, not on yours, so it can't reach your passkey.
- Signing in with your phone by scanning a QR code also doesn't work there. That method needs Bluetooth between your phone and the computer running the browser, and a cloud computer has none.
- **On your own computer**, a bot's browser runs without a window, so your system's passkey prompt has nowhere to appear.

A bot's browser has no passkey of its own, so it answers Google's request straight away as "no passkey here", the way your own browser does when you close its passkey window. Google then lets you choose another way. The browser shows a banner explaining this, and the bot is told to stop retrying and choose **Try another way**, or to use the browser on your own computer.

## Use a connected app instead

If the bot needs your email, calendar or files, it doesn't need a browser sign-in at all. Open **Connected apps**, connect Gmail, Google Calendar or Google Drive, and allow that app for the bot. The banner's **Open Connected apps** button takes you there. The bot then uses Google through the connection, which keeps working after a browser restart and never meets a passkey prompt.

Microsoft accounts work the same way: connect Outlook, Outlook Calendar or OneDrive.

## Take over the browser and sign in with a password

When a website itself needs the browser signed in, take over the bot's browser from the **Sign in needed** card or the Screen panel's Browser tab:

1. On the passkey step, choose **Try another way**.
2. Choose **Enter your password**, and type it with **Type a password or code…** in the browser menu.
3. When Google asks for a second step, use a code from your authenticator app, a text message, or one of your backup codes.
4. Press **Done** on the card. The bot checks it is signed in and continues.

If you saved a login for the account, with its 2FA setup key, the bot can do this itself: it chooses **Try another way**, picks the password, and SanRemes fills the password and code. The bot never sees either.

For a Microsoft account, choose **Other ways to sign in** instead.

## Use the browser on your own computer

Your passkey works in the browser on your own computer. While the desktop app is open there, signed in to SanRemes Cloud, with apps and screen working (on a Mac, once it allows SanRemes Accessibility and Screen Recording), a bot can open Google in your own browser there and work in it. You approve the passkey at the computer when it asks. This route is slower than a connected app, and the computer must stay awake and unlocked while the bot works.

## If it still doesn't work

- **The page doesn't respond when you click Try another way.** An older SanRemes leaves the passkey request waiting, which can freeze the page. Update the desktop app and SanRemes Cloud, or restart the browser from the Browser tab's menu and use the password route above.
- **Google says the browser isn't secure, or blocks the sign-in.** Use the password route above. Google limits sign-ins from automated browsers, and connected apps aren't affected.
- **No password on the account.** A passkey-only account has no password to fall back on. Add one in your Google Account (**Security → How you sign in to Google**), or use the password route or the own-computer route above.

_Adapted from the upstream OpenMausBot documentation (Apache 2.0)._
