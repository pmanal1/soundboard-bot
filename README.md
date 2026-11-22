# soundboard-bot

A discord bot to play sounds.

Currently set up in my homelab under an Ubuntu VM.

### Todo
* Add more sound files! (ongoing)
* Autocomplete for /play?
* Dropdown sound menu?

#### Completed 
* Add a command to stop the discord bot from playing the sound
* Change the replies to be user-facing only (to avoid spam)
* Add a command to list possible sounds
* If the discord bot is not in a channel when the sound command is issued, join the user's channel and play the sound.
* When the bot leaves, pause the music.

### project commands

`npm ci` - installs the exact dependency versions from package-lock.json (use this instead of `npm install` when setting up)

`npm run build` - builds the project into a js file, located in dist/

`npm run exec` - starts the discord bot and restarts it if it crashes (backoff from 1s up to 60s). It does not restart on a clean exit or a configuration error (missing env vars / invalid token).

`npm run exec:once` - starts the discord bot without auto-restart

`npm test` - builds the project and runs the tests in test/
