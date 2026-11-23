// Prints the soundboard layout for a few sound counts, page by page.
// Usage: npm run demo            (21 and 57 sounds)
//        npm run demo -- 0 1 100 (custom counts)
import { buildSoundboardLayout, MAX_ACTION_ROWS, MAX_BUTTONS_PER_ROW } from "../dist/soundboard-layout.js";

const counts = process.argv.slice(2).map(Number).filter(n => Number.isInteger(n) && n >= 0);
const WIDTH = 13;

const fit = text => (text.length > WIDTH ? `${text.slice(0, WIDTH - 1)}…` : text).padEnd(WIDTH);

function cell(button) {
  if (button.kind === "sound") return fit(button.name);
  return fit(button.disabled ? `(${button.label})` : button.label);
}

for (const count of counts.length > 0 ? counts : [21, 57]) {
  const names = Array.from({ length: count }, (_, i) => `sound ${String(i + 1).padStart(2, "0")}`);
  const { pageCount } = buildSoundboardLayout(names, 0);

  console.log(`\n=== ${count} sounds -> ${pageCount} page(s) ===`);

  for (let page = 0; page < pageCount; page++) {
    const layout = buildSoundboardLayout(names, page);
    const maxPerRow = Math.max(...layout.rows.map(r => r.length));

    console.log(`\nPage ${layout.page + 1}/${layout.pageCount}  (${layout.rows.length}/${MAX_ACTION_ROWS} rows, max ${maxPerRow}/${MAX_BUTTONS_PER_ROW} per row)`);

    for (const row of layout.rows) {
      console.log(`  | ${row.map(cell).join(" | ")} |`);
    }
  }

  const clamped = buildSoundboardLayout(names, pageCount + 3);
  console.log(`\nRequesting page ${pageCount + 4} shows page ${clamped.page + 1} (clamped)`);
}
