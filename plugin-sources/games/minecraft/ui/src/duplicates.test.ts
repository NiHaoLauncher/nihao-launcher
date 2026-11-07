// Run with: node --test src/duplicates.test.ts   (Node 22.6+ strips the types itself)
import assert from "node:assert/strict";
import { test } from "node:test";
import { isSamePack, membersOf, mergeSamePacks, mergeVersions } from "./duplicates.ts";
import type { VersionSource } from "./duplicates.ts";
import type { BrowseHit, ModpackVersion } from "./services.ts";

function hit(service: string, title: string, slug: string, authors: string[], updated?: string): BrowseHit {
  return {
    service, project_id: `${service}-${slug}`, title, slug, authors, author: authors[0], description: "", downloads: 1,
    environment: [], categories: [], gallery: [], game_versions: [], loaders: [], url: "", updated,
  };
}

// Pairs taken from the real top lists of both services.
test("the same pack on two services is recognised", () => {
  assert.ok(isSamePack(hit("modrinth", "Fabulously Optimized", "fabulously-optimized", ["robotkoer"]), hit("curseforge", "Fabulously Optimized", "fabulously-optimized", ["robotkoer"])));
  // Same title and author, different slugs.
  assert.ok(isSamePack(hit("modrinth", "Prominence™ II: Hasturian Era", "prominence-2-fabric", ["ElocinDev"]), hit("curseforge", "Prominence II: Hasturian Era", "prominence-2-hasturian-era", ["ElocinDev"])));
  // Same slug and author, decorated title; and the author is one of several.
  assert.ok(isSamePack(hit("modrinth", "SteamPunk", "steam-punk", ["SHXRKIE"]), hit("curseforge", "SteamPunk [LPS]", "steam-punk", ["SHXRKIE", "LunaPixelStudios"])));
  // Same title and slug, different publisher accounts.
  assert.ok(isSamePack(hit("modrinth", "Better MC [FORGE] BMC4", "better-mc-forge-bmc4", ["SHXRKIE"]), hit("curseforge", "Better MC [FORGE] BMC4", "better-mc-forge-bmc4", ["LunaPixelStudios"])));
});

test("namesakes and variants are not merged", () => {
  assert.ok(!isSamePack(hit("modrinth", "Create+", "create_plus", ["Sshmoob"]), hit("curseforge", "Create+", "create", ["evanev7"])));
  assert.ok(!isSamePack(hit("modrinth", "One Block Horror", "one-block-horror-dweller", ["kamussy"]), hit("curseforge", "One Block Horror", "one-block-horror", ["Zokaritas"])));
  // Loader variants of one pack are different packs.
  assert.ok(!isSamePack(hit("modrinth", "Better MC [FABRIC] BMC3", "better-mc-fabric-bmc3", ["SHXRKIE"]), hit("curseforge", "Better MC [FORGE] BMC4", "better-mc-forge-bmc4", ["SHXRKIE"])));
  // A service never matches itself.
  assert.ok(!isSamePack(hit("modrinth", "Same", "same", ["a"]), hit("modrinth", "Same", "same", ["a"])));
});

test("merging keeps the order and lists every service of a pack once", () => {
  const merged = mergeSamePacks([
    hit("modrinth", "Fabulously Optimized", "fabulously-optimized", ["robotkoer"]),
    hit("curseforge", "ATM10", "atm10", ["ATM"]),
    hit("modrinth", "Aged", "aged", ["x"]),
    hit("curseforge", "Fabulously Optimized", "fabulously-optimized", ["robotkoer"]),
  ]);
  assert.deepEqual(merged.map((m) => m.title), ["Fabulously Optimized", "ATM10", "Aged"]);
  assert.deepEqual(merged[0].also.map((a) => a.service), ["curseforge"]);
  assert.equal(merged[1].also.length, 0);
});

test("the service with the freshest data is the one a merged pack shows", () => {
  const modrinth = hit("modrinth", "Fabulously Optimized", "fabulously-optimized", ["robotkoer"], "2026-10-11T12:00:00Z");
  const curseforge = { ...hit("curseforge", "Fabulously Optimized", "fabulously-optimized", ["robotkoer"], "2026-10-02T09:00:00Z"), gallery: ["https://cf/shot.png"], icon_url: "https://cf/icon.png" };
  const [fresh] = mergeSamePacks([curseforge, modrinth]);
  assert.equal(fresh.service, "modrinth");
  assert.deepEqual(membersOf(fresh).map((m) => m.service), ["modrinth", "curseforge"]);
  // What the freshest lacks comes from the other.
  assert.deepEqual(fresh.gallery, ["https://cf/shot.png"]);
  assert.equal(fresh.icon_url, "https://cf/icon.png");
  // No dates at all: the first one stays.
  const [tie] = mergeSamePacks([hit("curseforge", "A", "a", ["x"]), hit("modrinth", "A", "a", ["x"])]);
  assert.equal(tie.service, "curseforge");
});

function build(service: string, name: string, number: string, date: string): VersionSource {
  const version: ModpackVersion = { id: `${service}-${number}`, name, version_number: number, version_type: "release", game_versions: [], loaders: [], date_published: date, downloads: 0 };
  return { service, projectId: `${service}-pack`, version };
}

// Names as the two services really publish them.
test("the same build on two services is one row", () => {
  const modrinth = [
    build("modrinth", "15.0.0-beta.1 for 26.3", "15.0.0-beta.1", "2026-10-11T12:00:00Z"),
    build("modrinth", "Society: Sunlit Valley 4.1.5A", "4.1.5A", "2026-09-26T10:00:00Z"),
    build("modrinth", "COBBLEVERSE 1.7.42", "1.7.42", "2026-07-21T20:00:00Z"),
    build("modrinth", "Only on Modrinth 2.0", "2.0", "2026-06-01T10:00:00Z"),
  ];
  const curseforge = [
    build("curseforge", "15.0.0-beta.1 for 26.3", "15.0.0-beta.1 for 26.3", "2026-10-11T12:30:00Z"),
    build("curseforge", "Society - Sunlit Valley - 4.1.5A", "Society - Sunlit Valley - 4.1.5A", "2026-09-26T11:00:00Z"),
    build("curseforge", "COBBLEVERSE 1.7.42 [CF]", "COBBLEVERSE 1.7.42 [CF]", "2026-07-22T04:00:00Z"),
    build("curseforge", "Only on CurseForge 3.0", "3.0", "2026-12-01T10:00:00Z"),
  ];
  const rows = mergeVersions([modrinth, curseforge]);
  assert.equal(rows.length, 5);
  // Newest first, whichever service it is on.
  assert.deepEqual(rows[0].map((s) => s.service), ["curseforge"]);
  // The first list's copy comes first in a shared row.
  assert.deepEqual(rows.filter((r) => r.length === 2).map((r) => r.map((s) => s.service).join("+")), ["modrinth+curseforge", "modrinth+curseforge", "modrinth+curseforge"]);
});

test("naming differences between the services are looked through", () => {
  const row = (a: string, b: string, aDate = "2026-05-01T00:00:00Z", bDate = "2026-06-20T00:00:00Z") =>
    mergeVersions([[build("modrinth", a, a, aDate)], [build("curseforge", b, b, bDate)]]).length;
  // A `v` before the number, a colon, and the service uploading weeks later.
  assert.equal(row("Prominence™ II: Hasturian Era 4.0.3", "Prominence™ II Hasturian Era v4.0.3"), 1);
  // Tags and emoji the other service adds.
  assert.equal(row("3.0.0-alpha.4 for 1.18", "3.0.0-alpha.4 for 1.18 (CurseForge)"), 1);
  assert.equal(row("1.7.0 for 1.16.5", "⚠️1.7.0 for 1.16.5"), 1);
  assert.equal(row("COBBLEVERSE 1.7.2", "COBBLEVERSE 1.7.2 [CF]"), 1);
  // A letter on the number makes it another build.
  assert.equal(row("COBBLEVERSE 1.7.41b", "COBBLEVERSE 1.7.41 [CF]"), 2);
});

test("different builds are not folded together", () => {
  // "1.8" is not "1.8.1", even though one name is inside the other.
  assert.equal(mergeVersions([[build("modrinth", "Pack 1.8", "1.8", "2026-05-01T00:00:00Z")], [build("curseforge", "Pack 1.8.1", "1.8.1", "2026-05-02T00:00:00Z")]]).length, 2);
  // Builds of one service never merge with each other.
  assert.equal(mergeVersions([[build("modrinth", "Pack 2.0", "2.0", "2026-05-01T00:00:00Z"), build("modrinth", "Pack 2.0", "2.0b", "2026-05-01T00:00:00Z")]]).length, 2);
});
