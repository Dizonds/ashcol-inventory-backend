import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupBrandLogo } from "../src/brandLogos.js";

const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });

test("logo lookup resolves the company and uses its preferred logo instead of a photo", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (urls.length === 1) return reply({ wikibase_item: "Q1157589", originalimage: { source: "headquarters.jpg" } });
    return reply({ entities: { Q1157589: { claims: { P154: [
      { rank: "deprecated", mainsnak: { datavalue: { value: "Old logo.svg" } } },
      { rank: "normal", mainsnak: { datavalue: { value: "Other logo.svg" } } },
      { rank: "preferred", mainsnak: { datavalue: { value: "DAIKIN logo.svg" } } },
    ] } } } });
  };
  const logo = await lookupBrandLogo("Daikin", fetchImpl);
  assert.match(urls[0], /page\/summary\/Daikin$/);
  assert.match(urls[1], /Special:EntityData\/Q1157589.json$/);
  assert.equal(logo.url, "https://upload.wikimedia.org/wikipedia/commons/0/05/DAIKIN_logo.svg");
  assert.match(logo.sourceUrl, /File:DAIKIN_logo.svg$/);
});

test("short company labels resolve to the correct article", async () => {
  let requested;
  assert.equal(await lookupBrandLogo("LG", async (url) => { requested = url; return reply({}, 404); }), null);
  assert.match(requested, /LG%20Electronics$/);
});

test("missing logos and generic parts do not produce unrelated images", async () => {
  const noLogo = async (url) => reply(url.includes("summary") ? { wikibase_item: "Q1" } : { entities: { Q1: { claims: {} } } });
  assert.equal(await lookupBrandLogo("Unknown", noLogo), null);
  assert.equal(await lookupBrandLogo("Generic Parts", () => { throw new Error("Must not call provider"); }), null);
});

test("provider errors are distinguished from a missing logo", async () => {
  await assert.rejects(lookupBrandLogo("Daikin", async () => reply({}, 429)), /429/);
});
