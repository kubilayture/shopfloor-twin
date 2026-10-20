/**
 * The regression check of #265 in the simulator image (Linux, where the race shows): the stack
 * smoke runs `docker compose run --rm --no-deps opcua-tools node apps/simulator/src/opcua/pin-race-cli.ts`.
 * It works in a temporary folder of its own and touches no volume.
 *
 * Environment: PIN_RACE_RERUNS (default 10), PIN_RACE_RENEWALS (default 6).
 * Exit 0 when every running certificate manager trusted every pin after every run, 1 otherwise.
 */
import { checkPinRace } from './pin-race.ts';

try {
  const result = await checkPinRace({
    reruns: Number(process.env.PIN_RACE_RERUNS ?? 10),
    renewals: Number(process.env.PIN_RACE_RENEWALS ?? 6),
    log: (line) => {
      console.log(`pin-race: ${line}`);
    },
  });
  if (result.lost.length > 0) {
    for (const line of result.lost) console.error(`FAIL: ${line}`);
    console.error(
      `FAIL: running certificate managers lost a pin in ${String(result.lost.length)} check(s) over ${String(result.runs)} pki runs`,
    );
    process.exit(1);
  }
  console.log(
    `ok: every pin stayed trusted by the running managers over ${String(result.runs)} pki runs`,
  );
  process.exit(0);
} catch (error) {
  console.error('FAIL: pin race check', error);
  process.exit(1);
}
