Rolling build of the uwucrew tools. Each file is rebuilt automatically whenever its part of the code changes on `main`.

**uwucrew Sync app** installs the addon, keeps it updated, syncs your characters to Discord and shows them:
- Windows: `uwucrew-sync-windows-setup.exe`. If SmartScreen warns, click *More info → Run anyway*.
- Mac (M1 and newer): `uwucrew-sync-mac-arm64.dmg`. Mac (Intel): `uwucrew-sync-mac-x64.dmg`. Open it and drag the app into Applications.
- Linux: `uwucrew-sync-linux-x86_64.AppImage`. Make it executable and run it. If it won't start (Ubuntu 24.04 and newer), run it with `--no-sandbox`.

Setup: open the app, run `/sync link` in Discord and paste the code into the app. Then play: it syncs each time you log out or `/reload`. The app updates itself.

The `.zip` and `latest*.yml` files are for the app's automatic updates; you don't need to download them.

**uwucrew Sync addon** on its own: `UwucrewSync.zip`. Unzip into your WoW Forever `Interface/AddOns` folder. Not needed if you use the app.
