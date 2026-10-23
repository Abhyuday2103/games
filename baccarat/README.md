# Baccarat 5 Treasures

Live at `https://abhyuday2103.github.io/games/baccarat/`

Punto Banco with the 5 Treasures side bets. Up to 7 seats, friends on their own phones, bots to fill empty seats. Play money only.

## Running a table

1. Open the page, type your name, hit **Host a table**.
2. Tap the code at the top (or **Invite**) for the QR code and link. Friends open it, type a name and they are seated.
3. **+ Add bot** for computer players. Remove anyone from the gear menu.
4. Hit **Start dealing**. Everyone picks a chip, taps the spots, then hits **Deal**. The hand deals once every person is ready, or when the bet clock runs out. **Sit out** skips a hand.
5. The gear menu sets buy-in, min and max for main bets and for the Treasures, the bet clock, and whether Banker pays 5% commission or is commission free (a winning 6 pays half).

Keep the host page open. It runs the table. If the host refreshes, the table, chips and road come back and it reclaims the same code so the link still works.

## Payouts

| Bet | Pays |
|---|---|
| Player | 1 to 1 |
| Banker | 1 to 1 less 5% (or commission free, winning 6 pays 1 to 2) |
| Tie | 8 to 1, Player and Banker push |
| Fortune 7, Banker wins with a 3 card 7 | 40 to 1 |
| Golden 8, Player wins with a 3 card 8 | 25 to 1 |
| Heavenly 9, either hand on a 3 card 9 | 10 to 1 |
| Heavenly 9, both hands on 3 card 9s | 75 to 1 |
| Blazing 7s, both hands on 3 card 7s | 200 to 1 |
| Blazing 7s, both hands on 2 card 7s | 50 to 1 |
| Cover All, any of the four hits | 6 to 1 |

This is the paytable with the 2 card Blazing 7s line from the Nevada, New Jersey and Pennsylvania rules filings. Treasures need a main bet down. A 2 card 7 against a 3 card 7 does not count for Blazing 7s, since the filings do not cover that case.

## House edge (8 decks, exact)

Banker 1.06% (1.46% commission free), Player 1.24%, Tie 14.36%, Fortune 7 7.61%, Golden 8 10.19%, Heavenly 9 9.31%, Blazing 7s 7.78%, Cover All 2.97%.

`node baccarat/test/engine.test.js` works these out from every possible deal and checks the base game against the published numbers, plus the drawing rules and table flow.

## Files

- `engine.js` rules, shoe, settlement, bots, table state. No DOM.
- `app.js` host and guest over PeerJS (free lobby, no server, same setup as the other tables), and the UI.
- `index.html` layout and styles.
