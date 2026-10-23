# DJPal

Party song requests. Guests scan a QR code, search the Apple Music catalog on their phone, request songs and vote. The host sees a ranked queue with an estimated BPM, Camelot key and energy for every request, plus whether it mixes out of what is playing.

Live at `https://abhyuday2103.github.io/games/djpal/`

## Running a party

1. On the DJ device (iPad, Mac or phone) open DJPal, name the party, hit **Start a party**.
2. Hit **Party screen** and prop it up, or put it on the TV. Guests scan the QR code (or type the 4-letter code).
3. Guests type a name once, then search, request and vote.
4. Work from **Up next**. **Copy for djay** copies the song name and artist, paste it into djay's search with Apple Music as the source. **Apple Music** and **YT Music** open the song in those apps instead.
5. When it starts playing, tap **Next song** (or **Play now** on any song) so everyone's phone shows what is on.

## How the queue ranks

- 1 vote = 10 points. Requesting a song counts as your vote.
- Songs that have been waiting rise slowly, up to one vote's worth.
- A guest's 2nd and 3rd requests sit a little lower than their 1st, so one person cannot own the night.
- Each guest can have 3 songs waiting at a time (host can change it). Duplicate requests turn into votes.
- Songs already played tonight cannot be requested again (the host can still add them).
- **Mix-aware next pick**: if two songs are within a vote of each other, Up next picks the one whose key and tempo fit what is playing. A clear vote lead always wins.
- Host can **Bump up**, **Remove**, pause requests and turn off explicit tracks.

## Mixing helper

The host page downloads each song's 30 second Apple preview and estimates BPM, key and energy right in the browser. Tested on 15 well-known songs: BPM right on 13 (half or double counts), key exact on 10 and on a mix-compatible neighbor for all 15. Treat it as a guide; djay's own analysis is the final word once the track is loaded.

Labels: **Smooth mix** (key and tempo fit), **Key fits, tempo jump**, **Tempo fits, key clash**, **Workable**, **Hard mix, cut it in**.

## Things to know

- **Keep the host page open and on screen.** If the browser goes to the background (djay full screen on an iPad), guests drop until you come back. Use Split View with djay, or run DJPal on a second device. The page asks the screen to stay awake.
- If the host refreshes, the queue is kept and it reclaims the same code so the QR still works.
- Apple's free search allows roughly 20 lookups a minute per network. With a big crowd on one Wi-Fi, guests may see "Search is busy" for a few seconds.
- Peer-to-peer like the card games, using the free PeerJS lobby. No server, no accounts, nothing to pay.
- On iPhone, iPad and Mac, DJPal can't push songs into djay by itself. None of the apps offer a public way to do that there, so you load the track.
- **On Android it can.** The DJPal Android app (download from DJPal's start screen on an Android phone, or `DJPalBridge.apk`) adds Deck 1 / Deck 2 buttons that open djay, search the song and load it for you. Setup and details are in `djpal-android/README.md`.
