// The game view persists across a series: a full first-to-3 CPU match in one
// tab, from the matched frame that paints the opponent through non-final rounds
// that re-arm the countdown, to the final result whose Play Again starts the
// same match over. Every phase is asserted as painted, every POST read back as
// the server receives it, and any console error fails the test.
//
// This is the counterpart to the 1-off round in cpu-match.spec.js: there a
// single result is the whole match, here several results are not.
//
// The match is never assumed to end on a round number. A first-to-3 always
// plays at least three rounds, but a drawn round replays without counting, so
// the loop reads the Play Again button — the client's own seriesOver reading —
// and stops when it appears. Assertions never depend on who won: the pips
// count the round wins a series is owed, not which side holds them.
//
// Draws also make the round count unbounded in principle, so this test raises
// the suite timeout and caps the loop where the tail probability is negligible.
//
//   npm run e2e -- -g "series"
//   BASE_URL=https://your-server.example npm run e2e
//
// Needs Chromium, so it runs on the laptop and not the phone
// (docs/development/environment.md). The match this test starts is a real one;
// /health's activeMatches is the check that the server let it go.
const { test, expect } = require('@playwright/test');
const { CONNECT_BOUND, watchErrors, gotoLobby, nextPost, lengthBtn } = require('./support.cjs');

// The countdown reads "\u200b" between rounds; the text of a round is anything
// else. The empty string lets a poll wait out the gap.
async function countText(page) {
  const t = await page.locator('#count').textContent();
  return t && t !== '\u200b' ? t : '';
}

// One round, from the countdown's unlock through the fired move to the result
// panel. The count is still showing the previous round's last frame when this
// is called, so the new round is only trusted once its own ack beat paints:
// joining a countdown late must still see READY before the PUN that unlocks
// the shot. Each round sets out with the moves locked.
async function playRound(page) {
  await expect(page.locator('.move[data-move="rock"]')).toBeDisabled();
  await expect.poll(() => countText(page), { timeout: CONNECT_BOUND }).toBe('READY');
  await expect.poll(() => countText(page), { timeout: CONNECT_BOUND }).toBe('PUN!');
  await expect(page.locator('.move[data-move="rock"]')).toBeEnabled();

  const movePost = nextPost(page, '/move');
  await page.locator('.move[data-move="rock"]').click();
  const posted = await movePost();
  expect(posted.move).toBe('rock');
  expect(typeof posted.clickedAt).toBe('number');
  expect(typeof posted.sawPunAt).toBe('number');

  await expect(page.locator('#banner')).toBeVisible();
}

// The result panel, after playRound: the outcome banner, the pips row that
// survives into the next countdown (roundsTarget wide — three here, no matter
// who holds the wins), and the Play Again button only a series that is truly
// over offers. Returns whether the server concluded seriesOver.
async function assertResult(page) {
  await expect(page.locator('#banner')).toHaveText(/You win!|You lose|Draw!/);
  await expect(page.locator('#you-pips')).toBeVisible();
  await expect(page.locator('#opp-pips')).toBeVisible();
  expect(await page.locator('#you-pips .pip').count()).toBe(3);
  expect(await page.locator('#opp-pips .pip').count()).toBe(3);

  const final = await page.locator('#btn-again').isVisible();
  if (!final) await expect(page.locator('#btn-again')).toBeHidden();
  return final;
}

test('a CPU first-to-3 series runs its rounds, ends at seriesOver, and rematches', async ({ page }) => {
  // A drawn round replays without counting, so the dist to 3 wins is a heavy
  // tail; give the loop room rather than assuming a lucky short series.
  test.setTimeout(300000);
  const errors = watchErrors(page);
  await gotoLobby(page);

  // First to 3, once: the choice the client lights is the match the server is
  // asked to build.
  await lengthBtn(page, 3).click();
  await expect(lengthBtn(page, 3)).toHaveClass(/selected/);

  const seriesPost = nextPost(page, '/cpu');
  await page.locator('#btn-cpu').click();
  await expect(page.locator('#choose')).toBeVisible();
  await page.locator('#btn-start').click();

  const asked = await seriesPost();
  expect(asked.roundsTarget).toBe(3);
  expect(asked.drawEnds).toBe(false);

  // The matched frame opens the game view against the stub CPU.
  await expect(page.locator('#game')).toBeVisible();
  await expect(page.locator('#opp-slot')).toContainText('(cpu)');
  await expect(page.locator('.move[data-move="rock"]')).toBeDisabled();

  // Play until the server says the series is over. Round one can never decide
  // a first-to-3, so the first result must leave Play Again hidden. A drawn
  // round replays without counting, so the run to a decision has a heavy tail:
  // against a random stub, a series lasts more than eight rounds 13.5% of the
  // time (both sides still on ≤ 2 wins, everything else draws). Sixteen is the
  // cap where that tail is 0.015% — a guard against a hung server, not a
  // contract about how long a fair series takes.
  let final = false;
  for (let round = 1; round <= 16 && !final; round++) {
    await playRound(page);
    const over = await assertResult(page);
    if (round === 1) expect(over).toBe(false);
    final = over;
  }
  expect(final).toBe(true);

  // The final frame offers the rematch and disarms the move lock.
  await expect(page.locator('#btn-again')).toBeEnabled();

  // Play Again is the same match again, read off the result that just landed —
  // the rule pair, not the lobby's current selection.
  const againPost = nextPost(page, '/cpu');
  await page.locator('#btn-again').click();
  const again = await againPost();
  expect(again.roundsTarget).toBe(3);
  expect(again.drawEnds).toBe(false);

  // The count has been sitting on the old round's last frame since the result;
  // the fresh match proves itself by running a new countdown to a playable
  // window, and it is still a stub fight rather than a bounce to the lobby.
  await expect.poll(() => countText(page), { timeout: CONNECT_BOUND }).toBe('READY');
  await expect.poll(() => countText(page), { timeout: CONNECT_BOUND }).toBe('PUN!');
  await expect(page.locator('.move[data-move="rock"]')).toBeEnabled();
  await expect(page.locator('#opp-slot')).toContainText('(cpu)');

  expect(errors).toEqual([]);
});