# Obsidian Gdrive Sync

This is an unofficial sync plugin for Obsidian, specifically for Google Drive. It requires your own OAuth GDrive API key that you can create for free through Google Cloud Console.

## Disclaimer

- This is **not** the [official sync service](https://obsidian.md/sync) provided by Obsidian
-
- The details of this communication are explained at the bottom of the notes section

## Caution

**ALWAYS backup your vault before using this plugin.**
**Avoid using multiple devices at the same time. This plugin is not inteded for 3 way sync.**

## Features

- Syncing both ways (from Obsidian to Google Drive and back)
- Cross-device support
- Local file prioritization (automatically resolves conflicts)
- Multiple vaults per Google account
- Configuration syncing

## New Devices

- If you've already been using this plugin and want to start using it on a new device, then follow these instructions:
    1. Open Google Drive and download the entire Obsidian folder to your new device
    2. Move the Obsidian folder to the location where you want your vault to be
    3. Open Obsidian and set the vault location to the folder you just moved
- If you activate the plugin on a new device without downloading the Obsidian folder from Google Drive, the plugin will start downloading from Google Drive as per a typical sync, which could take an extremely long amount of time depending on the number of notes in Google Drive, but it would still work (we suggest the above method instead)

## Notes

- Do **NOT** manually upload files into the generated Obsidian Google Drive folder or use some other method of Google Drive sync
- This plugin cannot see these files, and it will likely break functionality, potentially causing data loss
- Do **NOT** manually change files outside of the Obsidian app, the plugin relies on GDrive's ID created within the plugin
- This plugin tracks file changes through the Obsidian API through Gdrive file ID, and if you change files outside of the app, the plugin will not be able to track these changes
- When activating this plugin on a new vault, make sure the vault is empty
- If you have files that you want to sync to Google Drive from before the plugin, move them to another vault, delete them from the current vault, activate the plugin, and copy them back in **THROUGH THE OBSIDIAN APP**
- Only edit Obsidian notes on one device at a time to avoid conflicts and syncing before editing on another device
- The plugin does have code to handle conflicts, but it might not be perfect or as the user expects, so try to avoid them
- Make sure to sync through an adequate internet connection
- Closing the app or losing connection while syncing could lead to data corruption
- The plugin does NOT have manual conflict resolution
- If you encounter a conflict, the plugin will automatically resolve it with local file prioritization
- Do **NOT** change the Obsidian configuration folder
- This only accesses the Google Drive API to sync files and does not access or store any data outside of the user's device
- This only accesses Google OAuth and Google Drive APIs required to sync files and authenticate with your Google account

## Google OAuth Setup

1. Create an OAuth client in [Google Cloud Console](https://console.cloud.google.com/).
2. Build or install the plugin.
3. Open the plugin settings and enter the OAuth client ID and client secret.
4. Click **Connect to Google Drive** and complete the device authorization flow.

- The OAuth credentials are entered after the plugin is built


## Obsidian Setup

** NOTE: This plugin requires you to have your own Google Drive API key. **

1. Enable the Obsidian Gdrive Sync plugin in Obsidian
2. Enter your Google OAuth client ID and client secret in plugin settings
3. Connect your Google account using the device-auth flow shown in the plugin UI
4. Save the settings and reload the Obsidian app if prompted

## Use

- After setup, the plugin will automatically sync your vault with Google Drive whenever Obsidian is open
- This sync is from Google Drive TO Obsidian, not the other way around (pulling cloud files)
- The plugin prioritizes unsynced local changes except for local file deletions (cloud file creation/modification will overwrite local deletion)
- Pulling new plugins/configurations may require a restart of Obsidian
- To sync local changes to Google Drive, click the sync button on the ribbon
- While you do not have to sync before you close Obsidian, we suggest doing so to ensure that Google Drive is up to date and no conflicts occur
- This will pull changes before pushing changes to Google Drive
- If you mess with the vault's files while Obsidian is closed, try to revert any of the changes you made

## Multiple Vaults

- The Google Drive folder that gets created upon setup is the root folder for the vault and is tagged with the vault name
- It is named the same as your vault name, has a matching description, and stores the vault name internally
- You can rename the Google Drive folder without consequence
- You can also color the folder in Google Drive and place it wherever you please
- Each file in the vault is also tagged with the vault name inside Google Drive's properties
- Each vault is connected to the Google Drive folder that has the same tag/internal name
- If you want multiple devices to sync to the same vault, the vault names must match
- You can have multiple vaults per Google account by having local vaults with different names
- Do NOT rename local vaults that you are syncing to Google Drive
- Instead, make a new vault, sync it, and transfer your files over

## Credits

This plugin was forked and updated from the one created by Richardx366 - https://github.com/richardx366/Obsidian-Google-Drive

Privacy Policy: This plugin stores only the refresh token and sync metadata needed for Google Drive access; no extra data is sent to a third-party service.
